import type { ContentType } from '@zendori/core';
import type { UnifiedInboundMessage } from '../types.js';
import { getHeader, type ResendInboundWebhook, type ResendReceivedEmail } from './schemas.js';
import {
  htmlToText,
  parseFromHeader,
  parseThreadRefs,
  sanitizeMessageId,
  stripReplyQuotes,
} from './mail-text.js';

/**
 * Map a Resend inbound webhook (metadata) + the retrieved full e-mail
 * (body + headers) to a normalized inbound message.
 *
 * - externalId = Resend `email_id` (idempotency key, unique per channel).
 * - contact = envelope sender (Phase 3; KI-extraction corrects it in Phase 4).
 * - content = cleaned body (html→text or text); contentType = 'html' if HTML
 *   was present, else 'text'. The reply-stripped variant is kept in
 *   metadata.email.stripped for later use (Phase 4), the full body stays as
 *   `content`.
 * - threadRef = space-joined RFC message-ids from In-Reply-To + References.
 * - metadata.email = { message_id, in_reply_to?, references?[], from_raw, to[],
 *   stripped } — message_id is this mail's own id, used for threading lookups.
 */
export function normalizeReceivedEmail(
  webhook: ResendInboundWebhook,
  fullEmail: ResendReceivedEmail
): UnifiedInboundMessage {
  const data = webhook.data;

  const fromRaw = (fullEmail.from ?? data.from ?? '').trim();
  const parsedFrom = parseFromHeader(fromRaw);
  const contact: UnifiedInboundMessage['contact'] = {};
  if (parsedFrom.email) contact.email = parsedFrom.email;
  if (parsedFrom.name) contact.name = parsedFrom.name;

  const html = fullEmail.html ?? null;
  const text = fullEmail.text ?? null;
  const hasHtml = typeof html === 'string' && html.trim().length > 0;
  const content = hasHtml ? htmlToText(html as string) : (text ?? '');
  const contentType: ContentType = hasHtml ? 'html' : 'text';
  const stripped = stripReplyQuotes(content);

  const headers = fullEmail.headers;
  // Only ever store a single, strictly valid <token> id — never a raw header line.
  const messageId = sanitizeMessageId(
    getHeader(headers, 'message-id') ?? data.message_id ?? undefined
  );
  const inReplyToHeader = getHeader(headers, 'in-reply-to') ?? null;
  const referencesHeader = getHeader(headers, 'references') ?? null;

  const inReplyToId = parseThreadRefs(inReplyToHeader, null)[0];
  const referenceIds = parseThreadRefs(null, referencesHeader);
  const threadRefs = parseThreadRefs(inReplyToHeader, referencesHeader);

  const to = fullEmail.to && fullEmail.to.length > 0 ? fullEmail.to : (data.to ?? []);

  const emailMeta: Record<string, unknown> = {
    from_raw: fromRaw,
    to,
    stripped,
  };
  if (messageId) emailMeta.message_id = messageId;
  if (inReplyToId) emailMeta.in_reply_to = inReplyToId;
  if (referenceIds.length > 0) emailMeta.references = referenceIds;

  const receivedAt = data.created_at ?? webhook.created_at ?? new Date().toISOString();

  const message: UnifiedInboundMessage = {
    channelType: 'email',
    externalId: data.email_id,
    contact,
    content,
    contentType,
    receivedAt,
    metadata: { email: emailMeta },
  };
  if (threadRefs.length > 0) {
    message.threadRef = threadRefs.join(' ');
  }
  return message;
}
