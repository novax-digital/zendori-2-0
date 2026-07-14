import { createHmac, timingSafeEqual } from 'node:crypto';

// Standard Webhooks (https://www.standardwebhooks.com/) verification — the
// scheme xAI uses for voice-call webhooks (same family as Svix/Resend). Signed
// content is `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the base64
// signing secret (optionally prefixed "whsec_"), signature header carries one
// or more space-separated "v1,<base64sig>" entries. Kept dependency-free.

const TOLERANCE_SECONDS = 5 * 60;

/** Thrown when required headers are missing or the signature is invalid. */
export class StandardWebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandardWebhookVerificationError';
  }
}

function secretBytes(secret: string): Buffer {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return Buffer.from(raw, 'base64');
}

/** Computes the Standard-Webhooks v1 signature (base64) for the given parts. */
export function signStandardWebhook(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: string
): string {
  return createHmac('sha256', secretBytes(secret))
    .update(`${id}.${timestamp}.${rawBody}`, 'utf8')
    .digest('base64');
}

/**
 * Verifies a Standard-Webhooks delivery. Throws StandardWebhookVerificationError
 * on any problem (missing headers, stale timestamp, signature mismatch); returns
 * void on success. Verify BEFORE parsing/acting on the body (§7).
 */
export function verifyStandardWebhook(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): void {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    throw new StandardWebhookVerificationError('missing webhook headers');
  }

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) {
    throw new StandardWebhookVerificationError('webhook timestamp outside tolerance');
  }

  const expected = Buffer.from(signStandardWebhook(secret, id, timestamp, rawBody), 'utf8');

  // Header may carry several space-separated signatures ("v1,<sig> v1,<sig>").
  for (const entry of signature.split(' ')) {
    const [version, sig] = entry.split(',');
    if (version !== 'v1' || !sig) continue;
    const candidate = Buffer.from(sig, 'utf8');
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return;
    }
  }
  throw new StandardWebhookVerificationError('signature mismatch');
}
