import { z } from 'zod';

// Zod schemas for the Resend e-mail integration boundary (Phase 3).
// The inbound webhook carries only metadata; the message body + headers are
// loaded separately via the receiving/retrieve endpoint. Unknown keys are
// stripped (zod default), so forward-compatible with Resend adding fields.

// --- shared helpers ----------------------------------------------------------

/** A single RFC header value — a string, or an array when the header repeats. */
const headerValueSchema = z.union([z.string(), z.array(z.string())]);

export type HeaderRecord = Record<string, string | string[]>;

function lowercaseHeaderKeys(input: HeaderRecord): HeaderRecord {
  const out: HeaderRecord = {};
  for (const [key, value] of Object.entries(input)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * Case-insensitive header lookup. Header records produced by the schemas below
 * already have lowercased keys; the name is lowercased again defensively.
 * Repeated headers (array values) are joined with a single space.
 */
export function getHeader(headers: HeaderRecord | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const value = headers[name.toLowerCase()];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(' ') : value;
}

// --- inbound webhook (type: email.received) ----------------------------------

export const resendInboundAttachmentMetaSchema = z.object({
  id: z.string(),
  filename: z.string().nullish(),
  content_type: z.string().nullish(),
  content_disposition: z.string().nullish(),
  content_id: z.string().nullish(),
});
export type ResendInboundAttachmentMeta = z.infer<typeof resendInboundAttachmentMetaSchema>;

export const resendInboundDataSchema = z.object({
  email_id: z.string(),
  created_at: z.string().nullish(),
  from: z.string().nullish(),
  to: z.array(z.string()).nullish(),
  cc: z.array(z.string()).nullish(),
  bcc: z.array(z.string()).nullish(),
  received_for: z.array(z.string()).nullish(),
  message_id: z.string().nullish(),
  subject: z.string().nullish(),
  attachments: z.array(resendInboundAttachmentMetaSchema).nullish(),
});
export type ResendInboundData = z.infer<typeof resendInboundDataSchema>;

/**
 * Full Resend webhook envelope. `type` is kept as a plain string so the route
 * can validate any event that reaches the endpoint and ignore (200) the ones
 * that are not `email.received` instead of rejecting them as malformed.
 */
export const resendInboundWebhookSchema = z.object({
  type: z.string(),
  created_at: z.string().nullish(),
  data: resendInboundDataSchema,
});
export type ResendInboundWebhook = z.infer<typeof resendInboundWebhookSchema>;

/** Discriminator for the only event kind this integration processes. */
export const RESEND_INBOUND_EVENT_TYPE = 'email.received' as const;

// --- retrieve response (GET /emails/receiving/{email_id}) --------------------

export const resendReceivedAttachmentSchema = z.object({
  id: z.string().nullish(),
  filename: z.string().nullish(),
  content_type: z.string().nullish(),
  content_id: z.string().nullish(),
  content_disposition: z.string().nullish(),
  size: z.number().nullish(),
  download_url: z.string().nullish(),
});
export type ResendReceivedAttachment = z.infer<typeof resendReceivedAttachmentSchema>;

export const resendReceivedEmailSchema = z.object({
  html: z.string().nullish(),
  text: z.string().nullish(),
  subject: z.string().nullish(),
  from: z.string().nullish(),
  to: z.array(z.string()).nullish(),
  cc: z.array(z.string()).nullish(),
  // Header keys are case-insensitive in RFC 5322 — normalize to lowercase so
  // downstream reads via getHeader() are deterministic.
  headers: z.record(z.string(), headerValueSchema).default({}).transform(lowercaseHeaderKeys),
  attachments: z.array(resendReceivedAttachmentSchema).nullish(),
  raw: z
    .object({
      download_url: z.string().nullish(),
      expires_at: z.string().nullish(),
    })
    .nullish(),
});
export type ResendReceivedEmail = z.infer<typeof resendReceivedEmailSchema>;

// --- send response (POST /emails) --------------------------------------------

export const resendSendResponseSchema = z.object({
  id: z.string(),
});
export type ResendSendResponse = z.infer<typeof resendSendResponseSchema>;
