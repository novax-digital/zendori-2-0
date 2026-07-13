import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  resendReceivedEmailSchema,
  resendSendResponseSchema,
  sanitizeMessageId,
} from '@zendori/channels';

/**
 * Minimal Resend REST client (no SDK — full control over threading headers and
 * one dependency less). Reads RESEND_API_KEY / RESEND_API_BASE / INBOUND_EMAIL_DOMAIN
 * from the server env. Never logs email content, headers or addresses.
 */

const DEFAULT_API_BASE = 'https://api.resend.com';

/** Thrown when a required Resend env var is missing → the route answers 503. */
export class ResendConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResendConfigError';
  }
}

/** Thrown when a Resend request fails or its response is malformed → the route answers 5xx (Resend retries). */
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

export type ReceivedEmail = z.infer<typeof resendReceivedEmailSchema>;

/** Loads body + headers of an inbound email (webhook payloads carry metadata only). */
export async function fetchReceivedEmail(emailId: string): Promise<ReceivedEmail> {
  const res = await resendRequest(`/emails/receiving/${encodeURIComponent(emailId)}`);
  const json = await parseJson(res, 'fetchReceivedEmail');
  const parsed = resendReceivedEmailSchema.safeParse(json);
  if (!parsed.success) {
    throw new ResendApiError('received email response did not match schema');
  }
  return parsed.data;
}

// The /attachments endpoint response is owned here (Builder A only models the
// email-retrieve / webhook / send shapes). Kept lenient — Resend may wrap the
// list in a `data` envelope and omit optional fields.
const receivedAttachmentSchema = z.object({
  id: z.string().optional(),
  filename: z.string().optional(),
  content_type: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  download_url: z.string().min(1),
});

const receivedAttachmentsResponseSchema = z.union([
  z.array(receivedAttachmentSchema),
  z.object({ data: z.array(receivedAttachmentSchema) }),
]);

export type ReceivedAttachment = z.infer<typeof receivedAttachmentSchema>;

/** Lists an inbound email's attachments with signed download URLs. Returns [] when there are none. */
export async function fetchReceivedEmailAttachments(
  emailId: string
): Promise<ReceivedAttachment[]> {
  const key = apiKey();
  const url = `${apiBase()}/emails/receiving/${encodeURIComponent(emailId)}/attachments`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  } catch (cause) {
    throw new ResendApiError('attachments request failed', { cause });
  }
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new ResendApiError(`attachments request returned status ${res.status}`);
  }
  const json = await parseJson(res, 'fetchReceivedEmailAttachments');
  const parsed = receivedAttachmentsResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new ResendApiError('attachments response did not match schema');
  }
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
}

/** Downloads raw attachment bytes from a (CloudFront-signed) URL — no auth header. */
export async function downloadAttachment(url: string): Promise<{ bytes: Uint8Array }> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    throw new ResendApiError('attachment download failed', { cause });
  }
  if (!res.ok) {
    throw new ResendApiError(`attachment download returned status ${res.status}`);
  }
  const buffer = await res.arrayBuffer();
  return { bytes: new Uint8Array(buffer) };
}

export interface SendEmailParams {
  from: string;
  to: string;
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
    to: [params.to],
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
