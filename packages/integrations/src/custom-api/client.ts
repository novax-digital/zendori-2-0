// HTTP client for an org's OWN end systems (Phase 13 — data actions, outbound
// events). One request, no retries, no redirects: the caller decides what a
// non-2xx means. Injected fetch + injected SSRF guard keep it testable and keep
// the "public addresses only" rule in ONE place (the worker's assertPublicUrl).
//
// Security (§7): the credential only ever travels in the request headers; error
// messages are generic codes (never the URL, the body or the secret). Every
// request carries an Idempotency-Key and — when the connection has a signing
// secret — a Standard-Webhooks HMAC signature the end system can verify.
import { randomBytes } from 'node:crypto';
import { signStandardWebhook } from '@zendori/core';

export type CustomApiAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; secret: string }
  | { kind: 'header'; headerName: string; secret: string }
  | { kind: 'basic'; username: string; secret: string };

export type CustomApiErrorCode = 'blocked_url' | 'timeout' | 'network' | 'response_too_large';

/** Transport-level failure. `message` is the bare code — safe to log. */
export class CustomApiError extends Error {
  readonly code: CustomApiErrorCode;

  constructor(code: CustomApiErrorCode) {
    super(`custom api request failed (${code})`);
    this.name = 'CustomApiError';
    this.code = code;
  }
}

export interface CustomApiCall {
  url: string;
  method: string;
  /** JSON text or null (no body). */
  body: string | null;
  auth: CustomApiAuth;
  /** Decrypted signing secret; null/undefined = unsigned request. */
  signingSecret?: string | null;
  /** Unique id of this delivery: Idempotency-Key and webhook-id. */
  requestId: string;
  timeoutMs: number;
  /** Response size cap in bytes (default 256 KiB). */
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  /** SSRF guard — must throw unless the target is publicly routable. */
  assertUrl?: (url: string) => Promise<unknown>;
  /** Test seam: epoch milliseconds. */
  now?: () => number;
}

export interface CustomApiResponse {
  status: number;
  /** Parsed body, or undefined when the body is empty or not JSON. */
  json: unknown;
  text: string;
  latencyMs: number;
}

export const CUSTOM_API_MAX_RESPONSE_BYTES = 256 * 1024;
export const CUSTOM_API_USER_AGENT = 'Zendori-Actions/1.0';

/** New signing secret in the Standard-Webhooks format ("whsec_" + base64 of 32 bytes). */
export function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

function authHeaders(auth: CustomApiAuth): Record<string, string> {
  switch (auth.kind) {
    case 'none':
      return {};
    case 'bearer':
      return { authorization: `Bearer ${auth.secret}` };
    case 'header':
      return { [auth.headerName.toLowerCase()]: auth.secret };
    case 'basic':
      return {
        authorization: `Basic ${Buffer.from(`${auth.username}:${auth.secret}`, 'utf8').toString('base64')}`,
      };
  }
}

/** Headers of one delivery (exported for tests and for documenting the contract). */
export function buildRequestHeaders(
  call: Pick<CustomApiCall, 'auth' | 'body' | 'requestId' | 'signingSecret'>,
  nowMs: number
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': CUSTOM_API_USER_AGENT,
    'idempotency-key': call.requestId,
    ...authHeaders(call.auth),
  };
  if (call.body !== null) headers['content-type'] = 'application/json';
  if (call.signingSecret) {
    const timestamp = String(Math.floor(nowMs / 1000));
    headers['webhook-id'] = call.requestId;
    headers['webhook-timestamp'] = timestamp;
    headers['webhook-signature'] =
      `v1,${signStandardWebhook(call.signingSecret, call.requestId, timestamp, call.body ?? '')}`;
  }
  return headers;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CustomApiError('response_too_large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new CustomApiError('response_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Perform ONE request. Resolves for every HTTP status (redirects included —
 * they are never followed, so a 3xx to an internal host cannot be used to
 * bypass the SSRF guard); rejects with CustomApiError for transport failures.
 */
export async function callCustomApi(call: CustomApiCall): Promise<CustomApiResponse> {
  const fetchImpl = call.fetchImpl ?? fetch;
  const now = call.now ?? Date.now;
  const maxBytes = call.maxResponseBytes ?? CUSTOM_API_MAX_RESPONSE_BYTES;

  if (call.assertUrl) {
    try {
      await call.assertUrl(call.url);
    } catch {
      throw new CustomApiError('blocked_url');
    }
  }

  const started = now();
  const controller = new AbortController();
  // The timer spans the body download too — a slow-drip body must not hang a call.
  const timer = setTimeout(() => controller.abort(), call.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(call.url, {
        method: call.method,
        headers: buildRequestHeaders(call, started),
        body: call.body ?? undefined,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      throw new CustomApiError(controller.signal.aborted ? 'timeout' : 'network');
    }

    let text: string;
    try {
      text = await readCapped(response, maxBytes);
    } catch (err) {
      if (err instanceof CustomApiError) throw err;
      throw new CustomApiError(controller.signal.aborted ? 'timeout' : 'network');
    }

    let json: unknown = undefined;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: response.status, json, text, latencyMs: now() - started };
  } finally {
    clearTimeout(timer);
  }
}
