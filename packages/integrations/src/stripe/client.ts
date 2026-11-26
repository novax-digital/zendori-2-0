// Low-level Stripe REST helper (Phase 15, docs/phase-15-stripe.md). Hand-written
// like the HubSpot client: Bearer auth, form-encoded bodies, a pinned API
// version, zod-parsed responses, an injectable fetch for tests.
//
// Retries: only where a second attempt cannot double an effect — a transport
// error (the request may never have arrived; writes carry an Idempotency-Key),
// 409 (another request with the same key is still running) and 429. A 5xx is
// NOT retried here: Stripe stores the first result of an idempotency key and
// replays it, a saved 500 included, so the caller has to look at the object.
//
// Security: the secret key only ever travels in the Authorization header. Error
// messages are generic (method + status); Stripe's own error code and a short
// excerpt of its message live in fields. Request parameters never end up in an
// error or a log.
import type { z } from 'zod';

export const STRIPE_API_BASE = 'https://api.stripe.com';
/** Pinned so a Stripe release never changes a response shape under us. */
export const STRIPE_API_VERSION = '2026-11-18.endive';
export const STRIPE_DEFAULT_TIMEOUT_MS = 20_000;
/** Backoff before a retry of a transport error / 409 / 429. */
export const STRIPE_RETRY_DELAYS_MS: readonly number[] = [500, 2_000];

export interface StripeConfig {
  secretKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injectable for tests (no real waiting). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Test or live, read from the key: `sk_test_…` / `rk_test_…` are test keys,
 * `sk_live_…` / `rk_live_…` live keys. Anything else is not a secret key.
 */
export function stripeKeyLivemode(secretKey: string): boolean | null {
  if (/^(sk|rk)_live_[A-Za-z0-9]+$/.test(secretKey)) return true;
  if (/^(sk|rk)_test_[A-Za-z0-9]+$/.test(secretKey)) return false;
  return null;
}

// --- form encoding -----------------------------------------------------------

export type StripeParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | StripeParamValue[]
  | { [key: string]: StripeParamValue };
export type StripeParams = { [key: string]: StripeParamValue };

function appendParam(out: [string, string][], key: string, value: StripeParamValue): void {
  if (value === undefined) return;
  if (value === null) {
    // Stripe's way to unset a value
    out.push([key, '']);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendParam(out, `${key}[${index}]`, item));
    return;
  }
  if (typeof value === 'object') {
    for (const [child, childValue] of Object.entries(value)) {
      appendParam(out, `${key}[${child}]`, childValue);
    }
    return;
  }
  out.push([key, typeof value === 'string' ? value : String(value)]);
}

/** `a[b]=c&list[0]=x` — the nested form encoding of the Stripe API. */
export function encodeStripeForm(params: StripeParams): string {
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) appendParam(pairs, key, value);
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

// --- errors ------------------------------------------------------------------

const MESSAGE_EXCERPT_MAX = 300;

/** A non-success Stripe response. `message` is generic; details are fields. */
export class StripeApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  /** Stripe's error.code, e.g. `resource_missing`. */
  readonly code: string | null;
  /** Stripe's error.type, e.g. `invalid_request_error`. */
  readonly type: string | null;
  /** The request parameter Stripe complained about. */
  readonly param: string | null;
  /** At most 300 chars of Stripe's own message — never our request. */
  readonly detail: string;
  readonly requestId: string | null;

  constructor(
    status: number,
    method: string,
    path: string,
    info: {
      code?: string | null;
      type?: string | null;
      param?: string | null;
      detail?: string;
      requestId?: string | null;
    } = {}
  ) {
    super(`Stripe API request failed (${method}, status ${status})`);
    this.name = 'StripeApiError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.code = info.code ?? null;
    this.type = info.type ?? null;
    this.param = info.param ?? null;
    this.detail = (info.detail ?? '').slice(0, MESSAGE_EXCERPT_MAX);
    this.requestId = info.requestId ?? null;
  }
}

/** The request never produced a response (network, DNS, timeout). */
export class StripeNetworkError extends Error {
  readonly method: string;
  readonly path: string;
  readonly reason: 'timeout' | 'network';

  constructor(method: string, path: string, reason: 'timeout' | 'network') {
    super(`Stripe API request did not complete (${method}, ${reason})`);
    this.name = 'StripeNetworkError';
    this.method = method;
    this.path = path;
    this.reason = reason;
  }
}

/** The object does not exist (any more) for this key. */
export function isStripeNotFound(error: unknown): boolean {
  return (
    error instanceof StripeApiError && (error.status === 404 || error.code === 'resource_missing')
  );
}

/**
 * Worth another attempt later: no response, rate limit, lock, or a Stripe-side
 * failure. Everything else (4xx) says the request itself is wrong.
 */
export function isStripeRetryable(error: unknown): boolean {
  if (error instanceof StripeNetworkError) return true;
  if (error instanceof StripeApiError) {
    return error.status === 409 || error.status === 429 || error.status >= 500;
  }
  return false;
}

/** A short, content-free code for a queue row's last_error column. */
export function stripeErrorCode(error: unknown): string {
  if (error instanceof StripeNetworkError) return `network:${error.reason}`;
  if (error instanceof StripeApiError) {
    return error.code ? `stripe:${error.status}:${error.code}` : `stripe:${error.status}`;
  }
  return 'internal';
}

// --- request -----------------------------------------------------------------

export interface StripeResponse {
  status: number;
  json: unknown;
  requestId: string | null;
}

export interface StripeRequestOptions {
  /** Body parameters (POST) — form-encoded. */
  params?: StripeParams;
  /** Query parameters (GET / DELETE). */
  query?: StripeParams;
  /** Makes a write safe to send twice. Required for every POST that creates something. */
  idempotencyKey?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendOnce(
  config: StripeConfig,
  method: string,
  path: string,
  options: StripeRequestOptions
): Promise<StripeResponse> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = config.baseUrl ?? STRIPE_API_BASE;
  const query = options.query ? encodeStripeForm(options.query) : '';
  const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.secretKey}`,
    'Stripe-Version': STRIPE_API_VERSION,
  };
  let body: string | undefined;
  if (method !== 'GET' && method !== 'DELETE') {
    body = encodeStripeForm(options.params ?? {});
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? STRIPE_DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'error',
    });
  } catch {
    throw new StripeNetworkError(method, path, controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }

  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new StripeNetworkError(method, path, 'network');
  }
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, requestId: res.headers.get('request-id') };
}

function readStripeError(json: unknown): {
  code: string | null;
  type: string | null;
  param: string | null;
  detail: string;
} {
  const error =
    json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>).error
      : null;
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    code: text(record.code),
    type: text(record.type),
    param: text(record.param),
    detail: text(record.message) ?? '',
  };
}

/**
 * One Stripe request. Returns the response for 2xx and throws StripeApiError for
 * everything else (after the retries described at the top of this file), or
 * StripeNetworkError when no response arrived.
 */
export async function stripeRequest(
  config: StripeConfig,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: StripeRequestOptions = {}
): Promise<StripeResponse> {
  const sleep = config.sleep ?? defaultSleep;
  // A write without an idempotency key must never be sent twice.
  const repeatable = method !== 'POST' || Boolean(options.idempotencyKey);
  let attempt = 0;
  for (;;) {
    const delay = STRIPE_RETRY_DELAYS_MS[attempt];
    let response: StripeResponse;
    try {
      response = await sendOnce(config, method, path, options);
    } catch (error) {
      if (error instanceof StripeNetworkError && repeatable && delay !== undefined) {
        attempt += 1;
        await sleep(delay);
        continue;
      }
      throw error;
    }
    if (response.status >= 200 && response.status < 300) return response;
    const busy = response.status === 429 || response.status === 409;
    if (busy && repeatable && delay !== undefined) {
      attempt += 1;
      await sleep(delay);
      continue;
    }
    throw new StripeApiError(response.status, method, path, {
      ...readStripeError(response.json),
      requestId: response.requestId,
    });
  }
}

/** Request + parse the body against a schema; a drifted shape is a typed error. */
export async function stripeCall<T>(
  config: StripeConfig,
  schema: z.ZodType<T>,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: StripeRequestOptions = {}
): Promise<T> {
  const response = await stripeRequest(config, method, path, options);
  const parsed = schema.safeParse(response.json);
  if (!parsed.success) {
    throw new StripeApiError(response.status, method, path, {
      code: 'unexpected_response_shape',
      requestId: response.requestId,
    });
  }
  return parsed.data;
}

/** Path segment of an object id — ids are opaque, so they are always encoded. */
export function stripeId(id: string): string {
  return encodeURIComponent(id);
}
