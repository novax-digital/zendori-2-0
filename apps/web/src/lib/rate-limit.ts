import 'server-only';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

/**
 * Sliding-window rate limits for the public widget routes (Upstash Redis).
 * Fail-open by design: missing env vars or Upstash errors let requests
 * through — a broken limiter must never break the widget.
 */

export type RateLimitName =
  'widget-bootstrap-ip' | 'widget-session-ip' | 'widget-message-ip' | 'widget-message-conversation';

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
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const entries = forwarded.split(',');
    const last = entries[entries.length - 1]?.trim();
    if (last) return last;
  }
  return 'unknown';
}
