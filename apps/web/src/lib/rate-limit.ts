import 'server-only';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

/**
 * Sliding-window rate limits for the public widget routes (Upstash Redis).
 * Fail-open by design: missing env vars or Upstash errors let requests
 * through — a broken limiter must never break the widget.
 */

export type RateLimitName =
  | 'widget-bootstrap-ip'
  | 'widget-session-ip'
  | 'widget-message-ip'
  | 'widget-message-conversation'
  | 'widget-attachment-ip'
  | 'form-bootstrap-ip'
  | 'form-submit-ip'
  | 'form-submit-token'
  | 'demo-bootstrap-ip'
  | 'demo-request-ip'
  | 'demo-request-email'
  | 'demo-status-ip'
  | 'demo-verify-ip'
  | 'demo-resend-ip'
  | 'password-reset-ip'
  | 'password-reset-email'
  | 'contact-bootstrap-ip'
  | 'contact-submit-ip'
  | 'contact-submit-email'
  | 'api-v1-ip'
  | 'api-v1-key';

let limiters: Record<RateLimitName, Ratelimit> | null | undefined;
let warnedMissingEnv = false;

function getLimiters(): Record<RateLimitName, Ratelimit> | null {
  if (limiters !== undefined) return limiters;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    limiters = null;
    return null;
  }
  const redis = new Redis({ url, token });
  limiters = {
    'widget-bootstrap-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(30, '1 m'),
      prefix: 'zendori:rl:widget-bootstrap-ip',
    }),
    'widget-session-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, '1 m'),
      prefix: 'zendori:rl:widget-session-ip',
    }),
    'widget-message-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(30, '1 m'),
      prefix: 'zendori:rl:widget-message-ip',
    }),
    'widget-message-conversation': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(15, '1 m'),
      prefix: 'zendori:rl:widget-message-conversation',
    }),
    // The widget asks for a reply's images once per received bot message, so this
    // sits above widget-message-ip: reading is cheaper than writing.
    'widget-attachment-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(60, '1 m'),
      prefix: 'zendori:rl:widget-attachment-ip',
    }),
    'form-bootstrap-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(30, '1 m'),
      prefix: 'zendori:rl:form-bootstrap-ip',
    }),
    'form-submit-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, '1 m'),
      prefix: 'zendori:rl:form-submit-ip',
    }),
    'form-submit-token': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(30, '1 m'),
      prefix: 'zendori:rl:form-submit-token',
    }),
    // Demo-Anruf (0032): every request sends a paid verification code and every
    // verified one costs real call minutes, so the limits are tight. The DB
    // caps in lib/demo/server.ts are the fail-closed backstop when Upstash is
    // unavailable.
    'demo-bootstrap-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(30, '1 m'),
      prefix: 'zendori:rl:demo-bootstrap-ip',
    }),
    'demo-request-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, '1 h'),
      prefix: 'zendori:rl:demo-request-ip',
    }),
    'demo-request-email': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(3, '24 h'),
      prefix: 'zendori:rl:demo-request-email',
    }),
    // the embed polls every 4 s per open tab
    'demo-status-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(60, '1 m'),
      prefix: 'zendori:rl:demo-status-ip',
    }),
    // code entry: Twilio allows 5 checks per code, the row 5 attempts in total
    'demo-verify-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(20, '10 m'),
      prefix: 'zendori:rl:demo-verify-ip',
    }),
    'demo-resend-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(6, '10 m'),
      prefix: 'zendori:rl:demo-resend-ip',
    }),
    // "Passwort vergessen": every allowed request may send a mail
    'password-reset-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, '1 h'),
      prefix: 'zendori:rl:password-reset-ip',
    }),
    'password-reset-email': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(3, '1 h'),
      prefix: 'zendori:rl:password-reset-email',
    }),
    // Kontaktanfragen (0034): every accepted submit stores a row and sends a mail
    'contact-bootstrap-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(30, '1 m'),
      prefix: 'zendori:rl:contact-bootstrap-ip',
    }),
    'contact-submit-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, '1 h'),
      prefix: 'zendori:rl:contact-submit-ip',
    }),
    'contact-submit-email': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, '24 h'),
      prefix: 'zendori:rl:contact-submit-email',
    }),
    // Zendori API (Phase 13d): the IP limit runs BEFORE the key lookup (brake
    // on key guessing), the key limit after it (fair use per end system).
    'api-v1-ip': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(300, '1 m'),
      prefix: 'zendori:rl:api-v1-ip',
    }),
    'api-v1-key': new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(120, '1 m'),
      prefix: 'zendori:rl:api-v1-key',
    }),
  };
  return limiters;
}

/** Returns true if the request is allowed (or the limiter is unavailable). */
export async function checkRateLimit(name: RateLimitName, identifier: string): Promise<boolean> {
  const all = getLimiters();
  if (!all) {
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      console.warn(
        'rate-limit: UPSTASH_REDIS_REST_URL/TOKEN not set — rate limiting disabled (fail-open)'
      );
    }
    return true;
  }
  try {
    const { success } = await all[name].limit(identifier);
    return success;
  } catch {
    // Upstash unreachable → fail open, never block the widget
    return true;
  }
}

/**
 * Best-effort client IP for rate limiting. Prefers x-real-ip (set by Vercel,
 * trustworthy), then the LAST x-forwarded-for entry (appended by the closest
 * proxy — the leftmost entries are client-controlled and spoofable). Without
 * either, all requests share the fixed 'unknown' bucket instead of no limit.
 */
export function clientIp(request: Request): string {
  return clientIpFromHeaders(request.headers);
}

/** Same as clientIp, for server actions (next/headers). */
export function clientIpFromHeaders(headers: Headers): string {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const entries = forwarded.split(',');
    const last = entries[entries.length - 1]?.trim();
    if (last) return last;
  }
  return 'unknown';
}
