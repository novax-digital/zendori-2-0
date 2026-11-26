// Verification of Stripe webhook deliveries (Phase 15).
//
// Header `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…][,v0=…]`.
// The signature is HMAC-SHA256 over `${t}.${rawBody}` with the endpoint's
// signing secret. Several v1 entries appear while a secret is being rolled;
// unknown entries (v0 in sandboxes) are ignored. The raw body must be the exact
// bytes Stripe sent — never a re-serialized object.
//
// Several secrets are accepted: the test and the live endpoint each have their
// own, and a rolled secret overlaps with its successor.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;

export type StripeSignatureFailure =
  'no_secret' | 'missing_header' | 'malformed_header' | 'timestamp_out_of_tolerance' | 'no_match';

export class StripeSignatureError extends Error {
  readonly reason: StripeSignatureFailure;

  constructor(reason: StripeSignatureFailure) {
    super(`Stripe webhook signature rejected (${reason})`);
    this.name = 'StripeSignatureError';
    this.reason = reason;
  }
}

/** `STRIPE_WEBHOOK_SECRET` may hold several secrets, separated by commas. */
export function parseStripeWebhookSecrets(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function hexEquals(expectedHex: string, candidateHex: string): boolean {
  if (!/^[0-9a-f]+$/i.test(candidateHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const candidate = Buffer.from(candidateHex, 'hex');
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

/**
 * Throws StripeSignatureError unless one of the header's v1 signatures matches
 * one of the secrets and the timestamp is within the tolerance.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null | undefined,
  secrets: readonly string[],
  options: { toleranceSec?: number; nowMs?: number } = {}
): void {
  if (secrets.length === 0) throw new StripeSignatureError('no_secret');
  if (!header) throw new StripeSignatureError('missing_header');

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (timestamp === null || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) {
    throw new StripeSignatureError('malformed_header');
  }

  const toleranceSec = options.toleranceSec ?? STRIPE_SIGNATURE_TOLERANCE_SEC;
  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > toleranceSec) {
    throw new StripeSignatureError('timestamp_out_of_tolerance');
  }

  const payload = `${timestamp}.${rawBody}`;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
    // every candidate is compared, so timing does not reveal which one matched
    let matched = false;
    for (const candidate of signatures) {
      if (hexEquals(expected, candidate)) matched = true;
    }
    if (matched) return;
  }
  throw new StripeSignatureError('no_match');
}

/** Builds a valid header — for tests and local tooling. */
export function signStripePayload(rawBody: string, secret: string, timestampSec: number): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestampSec}.${rawBody}`, 'utf8')
    .digest('hex');
  return `t=${timestampSec},v1=${signature}`;
}
