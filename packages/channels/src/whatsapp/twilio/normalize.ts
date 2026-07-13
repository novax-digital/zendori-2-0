import type { ContentType } from '@zendori/core';
import type { UnifiedInboundMessage } from '../../types.js';
import type { TwilioInboundMessage } from './schemas.js';

/** Strips the "whatsapp:" prefix Twilio adds to From/To, leaving "+E164". */
export function stripWhatsappPrefix(value: string): string {
  return value.startsWith('whatsapp:') ? value.slice('whatsapp:'.length) : value;
}

/** Maps a media MIME type to the message content_type enum. */
function contentTypeForMedia(mime: string): ContentType {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Normalizes a parsed Twilio inbound WhatsApp message to the unified shape.
 * externalId=MessageSid (idempotency); contact carries phone (+E164) + waId;
 * media references are kept under metadata.whatsapp.media for the worker/route
 * to download with Basic auth. Pure — receivedAt is passed in so callers stay
 * deterministic/testable. Never returns raw tokens.
 */
export function normalizeWhatsAppTwilio(
  message: TwilioInboundMessage,
  receivedAt: string
): UnifiedInboundMessage {
  const phone = stripWhatsappPrefix(message.From);
  const waId = message.WaId ?? phone.replace(/^\+/, '');

  const hasMedia = message.media.length > 0;
  const contentType: ContentType = hasMedia
    ? contentTypeForMedia(message.media[0]!.contentType)
    : 'text';

  const contact: UnifiedInboundMessage['contact'] = { phone, waId };
  if (message.ProfileName && message.ProfileName.length > 0) {
    contact.name = message.ProfileName;
  }

  const whatsappMeta: Record<string, unknown> = {
    provider: 'twilio',
    wa_id: waId,
    message_sid: message.MessageSid,
  };
  if (message.ProfileName) whatsappMeta.profile_name = message.ProfileName;
  if (hasMedia) whatsappMeta.media = message.media;

  return {
    channelType: 'whatsapp',
    externalId: message.MessageSid,
    contact,
    content: message.Body ?? '',
    contentType,
    receivedAt,
    metadata: { whatsapp: whatsappMeta },
  };
}
