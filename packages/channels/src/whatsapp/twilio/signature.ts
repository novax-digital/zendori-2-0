import { createHmac, timingSafeEqual } from 'node:crypto';

// Twilio request-signature verification (X-Twilio-Signature), hand-rolled to
// avoid pulling the twilio SDK into the Vercel bundle. The algorithm is:
//   signature = base64( HMAC-SHA1( authToken, fullUrl + concat(sortedParams) ) )
// where sortedParams is every POST param sorted by name (case-sensitive) with
// name immediately followed by value, no separators.
// Docs: https://www.twilio.com/docs/usage/security#validating-requests

/**
 * Computes the expected X-Twilio-Signature for a request. `url` MUST be the exact
 * public URL Twilio called (scheme + host + path + any query), not a value
 * rebuilt from proxied headers — behind a proxy the reconstructed host/proto
 * differs and the HMAC silently fails.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

/** Constant-time comparison of the presented signature against the expected one. */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null | undefined
): boolean {
  if (!signature) return false;
  const expected = computeTwilioSignature(authToken, url, params);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
