import { z } from 'zod';

// Boundary schemas for the xAI voice webhook (realtime.call.incoming). The
// signed webhook carries the call id + SIP headers; everything else about the
// call flows over the worker's outbound WebSocket session.

const sipHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
});

export const xaiCallIncomingEventSchema = z.object({
  object: z.literal('event'),
  id: z.string(),
  type: z.literal('realtime.call.incoming'),
  created_at: z.number(),
  data: z.object({
    call_id: z.string().min(1),
    sip_headers: z.array(sipHeaderSchema).default([]),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type XaiCallIncomingEvent = z.infer<typeof xaiCallIncomingEventSchema>;

/** Loose peek at the event type only (other verified event types are acked + ignored). */
export const xaiEventTypePeekSchema = z.object({ type: z.string() });

/**
 * Extracts a SIP header value (case-insensitive name match) and normalizes a
 * number to +E164. Only values with an EXPLICIT leading "+" are accepted
 * ("+E164", "tel:+…", "sip:+…@host;params", '"Name" <sip:+…@host>') — a
 * national-format or display-name digit string must NOT be turned into a fake
 * E.164 by prefixing "+" (it would poison contact matching by phone).
 */
export function sipHeaderNumber(
  headers: { name: string; value: string }[],
  name: string
): string | null {
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  if (!header) return null;
  const match = header.value.trim().match(/\+[0-9][0-9 ()/-]{4,}/);
  if (!match) return null;
  const digits = match[0].replace(/[^0-9]/g, '');
  if (digits.length < 5 || digits.length > 15) return null;
  return `+${digits}`;
}
