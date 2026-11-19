import type {
  DemoFieldErrors,
  DemoFieldKey,
  DemoPublicStatus,
  DemoRequestPayload,
  DemoRequestResult,
  DemoResendResult,
  DemoVerifyChannel,
} from './types';

/**
 * HTTP layer for /api/demo/*. Responses are shape-checked by hand (no zod in
 * the browser bundle). Error bodies carry a German `error` text, a `code` and
 * optionally per-field messages — the embed shows them as-is.
 */

export class DemoApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** Server-provided German message, if any. */
  readonly serverMessage: string | null;
  readonly fields: DemoFieldErrors;
  /** Every per-field message as sent, unfiltered (the contact embed has its own field names). */
  readonly rawFields: Record<string, string>;
  /** Resend cooldown left, when the server says so. */
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: string | null,
    serverMessage: string | null,
    fields: DemoFieldErrors,
    retryAfterSeconds: number | null = null,
    rawFields: Record<string, string> = {}
  ) {
    super(`Demo API request failed with status ${status}`);
    this.name = 'DemoApiError';
    this.status = status;
    this.code = code;
    this.serverMessage = serverMessage;
    this.fields = fields;
    this.rawFields = rawFields;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const FIELD_KEYS: readonly DemoFieldKey[] = [
  'company',
  'contactName',
  'email',
  'phone',
  'websiteUrl',
  'prompt',
  'consent',
];

const PUBLIC_STATUSES: readonly DemoPublicStatus[] = [
  'awaiting_confirmation',
  'queued',
  'calling',
  'in_call',
  'completed',
  'no_answer',
  'busy',
  'failed',
  'expired',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRawFields(value: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!isRecord(value)) return fields;
  for (const [key, message] of Object.entries(value)) {
    if (typeof message === 'string' && message.length > 0) fields[key] = message;
  }
  return fields;
}

function parseFields(value: unknown): DemoFieldErrors {
  const fields: DemoFieldErrors = {};
  if (!isRecord(value)) return fields;
  for (const key of FIELD_KEYS) {
    const message = value[key];
    if (typeof message === 'string' && message.length > 0) fields[key] = message;
  }
  return fields;
}

/** POST JSON; a non-2xx answer becomes a DemoApiError (shared with the contact embed). */
export async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      // no JSON body
    }
    const record = isRecord(data) ? data : {};
    throw new DemoApiError(
      response.status,
      typeof record.code === 'string' ? record.code : null,
      typeof record.error === 'string' ? record.error : null,
      parseFields(record.fields),
      typeof record.retryAfterSeconds === 'number' ? record.retryAfterSeconds : null,
      parseRawFields(record.fields)
    );
  }
  return (await response.json()) as unknown;
}

export async function fetchRenderToken(apiBase: string): Promise<string> {
  const data = await postJson(`${apiBase}/api/demo/bootstrap`, {});
  if (!isRecord(data) || typeof data.renderToken !== 'string') {
    throw new Error('Demo API returned an unexpected response shape');
  }
  return data.renderToken;
}

function isChannel(value: unknown): value is DemoVerifyChannel {
  return value === 'sms' || value === 'call';
}

function parsePublicStatus(data: unknown): DemoPublicStatus {
  const status = isRecord(data) ? data.status : null;
  if (typeof status !== 'string' || !PUBLIC_STATUSES.includes(status as DemoPublicStatus)) {
    throw new Error('Demo API returned an unexpected response shape');
  }
  return status as DemoPublicStatus;
}

/** Creates the request; the server sends the verification code. */
export async function submitDemoRequest(
  apiBase: string,
  payload: DemoRequestPayload
): Promise<DemoRequestResult> {
  const data = await postJson(`${apiBase}/api/demo/request`, payload);
  if (
    !isRecord(data) ||
    data.ok !== true ||
    typeof data.statusToken !== 'string' ||
    !isChannel(data.channel) ||
    typeof data.phone !== 'string'
  ) {
    throw new Error('Demo API returned an unexpected response shape');
  }
  return { statusToken: data.statusToken, channel: data.channel, phone: data.phone };
}

/** Checks the code; resolves with the status after a successful verification. */
export async function verifyDemoCode(
  apiBase: string,
  token: string,
  code: string
): Promise<DemoPublicStatus> {
  return parsePublicStatus(await postJson(`${apiBase}/api/demo/verify`, { token, code }));
}

/**
 * Sends a fresh code. Resolves with a status instead when the request is no
 * longer waiting for a code (verified in another tab, expired).
 */
export async function resendDemoCode(
  apiBase: string,
  token: string,
  channel: DemoVerifyChannel
): Promise<DemoResendResult | { status: DemoPublicStatus }> {
  const data = await postJson(`${apiBase}/api/demo/resend`, { token, channel });
  if (isRecord(data) && typeof data.status === 'string') return { status: parsePublicStatus(data) };
  if (
    !isRecord(data) ||
    !isChannel(data.channel) ||
    typeof data.resendAfterSeconds !== 'number' ||
    typeof data.sendsLeft !== 'number'
  ) {
    throw new Error('Demo API returned an unexpected response shape');
  }
  return {
    channel: data.channel,
    resendAfterSeconds: data.resendAfterSeconds,
    sendsLeft: data.sendsLeft,
  };
}

export async function fetchDemoStatus(apiBase: string, token: string): Promise<DemoPublicStatus> {
  return parsePublicStatus(await postJson(`${apiBase}/api/demo/status`, { token }));
}
