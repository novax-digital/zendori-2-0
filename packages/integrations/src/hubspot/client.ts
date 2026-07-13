// Low-level HubSpot REST helper (docs/legacy-analysis.md §2.7). Bearer auth,
// JSON, and a fixed-backoff retry for 429 / 5xx. `request` NEVER throws on an
// unexpected HTTP status — it returns the last response so callers can branch on
// it (e.g. 404 → create, 400 → search fallback). Callers convert a hard failure
// to a typed error with `requestFailed`.
//
// Security: the token only ever travels in the Authorization header. Error
// `message` strings are generic (method + status) so a consumer that logs
// `err.message` never leaks the request path (which may contain an email),
// the response body, or the token. Detail lives in non-message fields that the
// worker's error logger does not read.
import type { z } from 'zod';
import type { HubSpotConfig } from './schemas.js';

export const DEFAULT_BASE_URL = 'https://api.hubapi.com';

/**
 * Fixed backoff for 429 / 5xx retries (§2.7: HubSpot sends no Retry-After).
 * Two entries → up to two retries, three attempts total.
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [2000, 8000];

export interface HubSpotResponse {
  status: number;
  json: unknown;
  bodyText: string;
  /** HubSpot rate-limit policy name from the 429 body, if present. */
  policyName: string | null;
  /** X-HubSpot-RateLimit-Remaining header, if present. */
  rateLimitRemaining: number | null;
}

export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

export type HubSpotAuthErrorKind = 'invalid_token' | 'missing_scope';

/**
 * A non-success HubSpot response surfaced as an error. The human-readable
 * `message` is deliberately generic; the path / body excerpt / policy name are
 * carried as fields for programmatic handling and are safe to inspect but should
 * not be logged wholesale.
 */
export class HubSpotApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  /** At most 300 chars of HubSpot's own error body — never our content. */
  readonly bodyExcerpt: string;
  readonly policyName: string | null;

  constructor(
    status: number,
    method: string,
    path: string,
    bodyExcerpt: string,
    policyName: string | null
  ) {
    super(`HubSpot API request failed (${method}, status ${status})`);
    this.name = 'HubSpotApiError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.bodyExcerpt = bodyExcerpt;
    this.policyName = policyName;
  }
}

/** 401 (invalid token) / 403 (missing scope) — lets callers show a precise hint. */
export class HubSpotAuthError extends HubSpotApiError {
  readonly kind: HubSpotAuthErrorKind;

  constructor(
    status: number,
    method: string,
    path: string,
    bodyExcerpt: string,
    policyName: string | null,
    kind: HubSpotAuthErrorKind
  ) {
    super(status, method, path, bodyExcerpt, policyName);
    this.name = 'HubSpotAuthError';
    this.kind = kind;
  }
}

const BODY_EXCERPT_MAX = 300;

/** Map a hard-failure response to a typed error (401/403 → auth error). */
export function requestFailed(
  method: string,
  path: string,
  response: HubSpotResponse
): HubSpotApiError {
  const excerpt = response.bodyText.slice(0, BODY_EXCERPT_MAX);
  if (response.status === 401) {
    return new HubSpotAuthError(
      response.status,
      method,
      path,
      excerpt,
      response.policyName,
      'invalid_token'
    );
  }
  if (response.status === 403) {
    return new HubSpotAuthError(
      response.status,
      method,
      path,
      excerpt,
      response.policyName,
      'missing_scope'
    );
  }
  return new HubSpotApiError(response.status, method, path, excerpt, response.policyName);
}

/** Parse a response body against a schema; throw a typed error on drift. */
export function parseJson<T>(
  schema: z.ZodType<T>,
  response: HubSpotResponse,
  method: string,
  path: string
): T {
  const parsed = schema.safeParse(response.json);
  if (!parsed.success) {
    throw new HubSpotApiError(
      response.status,
      method,
      path,
      'unexpected response shape',
      response.policyName
    );
  }
  return parsed.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPolicyName(json: unknown): string | null {
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const value = (json as Record<string, unknown>).policyName;
    if (typeof value === 'string') return value;
  }
  return null;
}

function readRateLimitRemaining(headers: Headers): number | null {
  const raw = headers.get('X-HubSpot-RateLimit-Remaining');
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function toHubSpotResponse(res: Response): Promise<HubSpotResponse> {
  const bodyText = await res.text();
  let json: unknown = null;
  if (bodyText.length > 0) {
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = null;
    }
  }
  return {
    status: res.status,
    json,
    bodyText,
    policyName: readPolicyName(json),
    rateLimitRemaining: readRateLimitRemaining(res.headers),
  };
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Perform a single HubSpot request with Bearer auth and JSON encoding. Retries
 * 429 and 5xx on the fixed backoff `DEFAULT_RETRY_DELAYS_MS`; otherwise returns
 * the response for the caller to branch on. Only a network/transport error (the
 * fetch call itself rejecting) propagates.
 */
export async function request(
  config: HubSpotConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<HubSpotResponse> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };

  const maxAttempts = DEFAULT_RETRY_DELAYS_MS.length + 1;
  let last: HubSpotResponse | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetchImpl(url, init);
    last = await toHubSpotResponse(res);
    if (!isRetryable(last.status)) return last;
    const delay = DEFAULT_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break; // out of retries
    await sleep(delay);
  }
  // `last` is always set: the loop runs at least once.
  return last as HubSpotResponse;
}
