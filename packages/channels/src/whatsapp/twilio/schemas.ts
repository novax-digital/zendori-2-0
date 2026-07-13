import { z } from 'zod';

// Zod boundary schemas for Twilio's WhatsApp webhooks. Twilio POSTs
// application/x-www-form-urlencoded, so the route hands us a flat
// Record<string, string>; these schemas validate the fields we rely on and a
// helper collapses the indexed MediaUrl{n}/MediaContentType{n} pairs.

/** Base inbound-message fields (media handled separately, see parseTwilioInbound). */
export const twilioInboundBaseSchema = z.object({
  /** 34-char SM…/MM… id — idempotency key. */
  MessageSid: z.string().min(1),
  /** Sender in "whatsapp:+E164" form. */
  From: z.string().min(1),
  /** Our business sender in "whatsapp:+E164" — the routing key. */
  To: z.string().min(1),
  Body: z.string().optional(),
  NumMedia: z.string().optional(),
  ProfileName: z.string().optional(),
  /** Sender's WhatsApp id (E.164 digits, no "+"). */
  WaId: z.string().optional(),
});

export type TwilioInboundBase = z.infer<typeof twilioInboundBaseSchema>;

/** A single inbound media part after collapsing the indexed params. */
export interface TwilioInboundMedia {
  url: string;
  contentType: string;
}

export interface TwilioInboundMessage extends TwilioInboundBase {
  media: TwilioInboundMedia[];
}

/**
 * Validates the base fields and collapses MediaUrl{n}/MediaContentType{n}
 * (0..NumMedia-1) into a typed media array. Returns null on a base-schema
 * mismatch so the route can 200-drop malformed callbacks without throwing.
 */
export function parseTwilioInbound(params: Record<string, string>): TwilioInboundMessage | null {
  const base = twilioInboundBaseSchema.safeParse(params);
  if (!base.success) return null;

  // WhatsApp allows a single media part per message; cap defensively so a bogus
  // NumMedia can't drive an unbounded loop.
  const count = Math.min(Number.parseInt(base.data.NumMedia ?? '0', 10) || 0, 20);
  const media: TwilioInboundMedia[] = [];
  if (count > 0) {
    for (let i = 0; i < count; i += 1) {
      const url = params[`MediaUrl${i}`];
      if (typeof url === 'string' && url.length > 0) {
        media.push({
          url,
          contentType: params[`MediaContentType${i}`] ?? 'application/octet-stream',
        });
      }
    }
  }

  return { ...base.data, media };
}

/** Status-callback fields (delivery lifecycle for our outbound messages). */
export const twilioStatusSchema = z.object({
  MessageSid: z.string().min(1),
  MessageStatus: z.enum(['queued', 'sent', 'delivered', 'read', 'failed', 'undelivered']),
  ErrorCode: z.string().optional(),
});

export type TwilioStatus = z.infer<typeof twilioStatusSchema>;
