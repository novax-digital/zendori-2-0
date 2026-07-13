// WhatsApp 24h customer service window (provider-independent). Each inbound
// message from the user opens/refreshes a 24h window; outside it only an
// approved template may be sent (Meta 131047 / Twilio 63016 otherwise). We
// derive the window from the newest inbound message rather than a dedicated
// column, so no migration is needed.

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the given last-inbound timestamp is still inside the 24h window.
 * Pure — `now` is injectable for tests. null/invalid ⇒ outside the window.
 */
export function isWithinServiceWindow(
  lastInboundAt: string | null,
  now: number = Date.now()
): boolean {
  if (!lastInboundAt) return false;
  const ts = Date.parse(lastInboundAt);
  if (Number.isNaN(ts)) return false;
  return now - ts < WINDOW_MS;
}
