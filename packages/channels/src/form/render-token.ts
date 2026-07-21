import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

// Render token: an HMAC the bootstrap endpoint issues and the submit endpoint
// verifies. It proves the form was actually rendered (bots that POST straight
// to /api/forms/submit fail) and carries the render time for the min-time
// check (a human needs a few seconds to fill a form). The key is derived from
// MASTER_ENCRYPTION_KEY via HKDF — no new env variable (§13).

const HKDF_INFO = 'zendori-form-render-token';
/** Submits faster than this after render are treated as bot traffic. */
export const RENDER_TOKEN_MIN_AGE_MS = 3_000;
/** A render older than this must re-bootstrap (embed does so transparently). */
export const RENDER_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function deriveKey(masterKeyBase64: string): Buffer {
  const master = Buffer.from(masterKeyBase64, 'base64');
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), HKDF_INFO, 32));
}

function sign(key: Buffer, formToken: string, issuedAt: number): string {
  return createHmac('sha256', key).update(`${formToken}.${issuedAt}`).digest('hex');
}

/** Issues a render token for a form's public token. */
export function issueRenderToken(
  masterKeyBase64: string,
  formToken: string,
  now: Date = new Date()
): string {
  const issuedAt = now.getTime();
  return `v1.${issuedAt}.${sign(deriveKey(masterKeyBase64), formToken, issuedAt)}`;
}

export type RenderTokenVerdict = 'ok' | 'too_fast' | 'expired' | 'invalid';

/** Verifies a render token against the form's public token + time window. */
export function verifyRenderToken(
  masterKeyBase64: string,
  formToken: string,
  renderToken: string,
  now: Date = new Date()
): RenderTokenVerdict {
  const parts = renderToken.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return 'invalid';
  const issuedAt = Number(parts[1]);
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) return 'invalid';
  const expected = sign(deriveKey(masterKeyBase64), formToken, issuedAt);
  const given = parts[2] ?? '';
  const expectedBuf = Buffer.from(expected, 'utf8');
  const givenBuf = Buffer.from(given, 'utf8');
  if (expectedBuf.length !== givenBuf.length || !timingSafeEqual(expectedBuf, givenBuf)) {
    return 'invalid';
  }
  const age = now.getTime() - issuedAt;
  if (age < RENDER_TOKEN_MIN_AGE_MS) return 'too_fast';
  if (age > RENDER_TOKEN_MAX_AGE_MS) return 'expired';
  return 'ok';
}
