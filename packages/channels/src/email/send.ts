import { randomUUID } from 'node:crypto';
import { resendSendResponseSchema } from './schemas.js';
import { sanitizeMessageId } from './mail-text.js';

/**
 * Minimal Resend REST send client (no SDK — full control over threading headers
 * and one dependency less). Reads RESEND_API_KEY / RESEND_API_BASE /
 * INBOUND_EMAIL_DOMAIN from the process env. Lives in @zendori/channels so both
 * apps/web (Phase 3 inbox reply) and apps/worker (Phase 5 auto-send) can send.
 * Never logs email content, headers or addresses (§7).
 */

const DEFAULT_API_BASE = 'https://api.resend.com';

/** Thrown when a required Resend env var is missing → caller answers 503. */
export class ResendConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResendConfigError';
  }
}

/** Thrown when a Resend request fails or its response is malformed → caller answers 5xx (Resend retries). */
export class ResendApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ResendApiError';
  }
}

function apiBase(): string {
  const configured = process.env.RESEND_API_BASE?.trim();
  return configured && configured.length > 0 ? configured.replace(/\/+$/, '') : DEFAULT_API_BASE;
}

function apiKey(): string {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new ResendConfigError('RESEND_API_KEY is not set');
  return key;
}

function inboundDomain(): string {
  const domain = process.env.INBOUND_EMAIL_DOMAIN?.trim();
  if (!domain) throw new ResendConfigError('INBOUND_EMAIL_DOMAIN is not set');
  return domain;
}

/** Performs an authenticated Resend API request. Resolves config before any I/O so config errors stay config errors. */
async function resendRequest(path: string, init?: RequestInit): Promise<Response> {
  const key = apiKey();
  const url = `${apiBase()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new ResendApiError(`request to ${path} failed`, { cause });
  }
  if (!res.ok) {
    throw new ResendApiError(`request to ${path} returned status ${res.status}`);
  }
  return res;
}

async function parseJson(res: Response, context: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (cause) {
    throw new ResendApiError(`could not parse ${context} response`, { cause });
  }
}

export interface SendEmailParams {
  from: string;
  /** One recipient (replies) or up to 10 (form-notification fan-out). */
  to: string | string[];
  /** Reply-To (intake address) so customer replies re-enter the inbox. */
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  /** RFC Message-ID of the mail being answered (In-Reply-To). */
  inReplyTo?: string;
  /** Full RFC References chain. */
  references?: string[];
}

/**
 * Sends an email via Resend. Generates its own Message-ID (<uuid@INBOUND_EMAIL_DOMAIN>)
 * and returns it so inbound-reply threading is deterministic.
 */
export async function sendEmail(
  params: SendEmailParams
): Promise<{ id: string; messageId: string }> {
  const domain = inboundDomain();
  const messageId = `<${randomUUID()}@${domain}>`;

  // Defensively sanitize caller-supplied threading ids against header injection:
  // accept only strict "<token>" values (drop anything with CR/LF, spaces, extras).
  const inReplyTo = sanitizeMessageId(params.inReplyTo);
  const references = (params.references ?? [])
    .map((ref) => sanitizeMessageId(ref))
    .filter((ref): ref is string => ref !== undefined);

  const headers: Record<string, string> = { 'Message-ID': messageId };
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  if (references.length > 0) {
    headers['References'] = references.join(' ');
  }

  const body = {
    from: params.from,
    to: Array.isArray(params.to) ? params.to : [params.to],
    reply_to: params.replyTo ? [params.replyTo] : undefined,
    subject: params.subject,
    text: params.text,
    html: params.html,
    headers,
  };

  const res = await resendRequest('/emails', { method: 'POST', body: JSON.stringify(body) });
  const json = await parseJson(res, 'sendEmail');
  const parsed = resendSendResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new ResendApiError('send response did not match schema');
  }
  return { id: parsed.data.id, messageId };
}
