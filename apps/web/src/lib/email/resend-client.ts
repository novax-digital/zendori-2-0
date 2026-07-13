import 'server-only';
import { z } from 'zod';
import { resendReceivedEmailSchema } from '@zendori/channels';

/**
 * Minimal Resend REST client for INBOUND e-mail (retrieve body + attachments).
 * No SDK — full control and one dependency less. Reads RESEND_API_KEY /
 * RESEND_API_BASE from the server env. Never logs email content, headers or
 * addresses. Outbound sending lives in @zendori/channels (email/send.ts) so the
 * worker can reuse it.
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
