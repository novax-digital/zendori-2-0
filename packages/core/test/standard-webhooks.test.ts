import { describe, expect, it } from 'vitest';
import {
  signStandardWebhook,
  verifyStandardWebhook,
  StandardWebhookVerificationError,
} from '../src/standard-webhooks.js';

const SECRET = Buffer.from('super-secret-signing-key-32bytes!').toString('base64');
const BODY = '{"type":"realtime.call.incoming","data":{"call_id":"abc"}}';
const ID = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W';
const NOW = 1_750_000_000;
const TS = String(NOW);

function headers(sig: string, id = ID, ts = TS) {
  return { id, timestamp: ts, signature: sig };
}

describe('standard webhooks verification', () => {
  it('accepts a correctly signed delivery', () => {
    const sig = signStandardWebhook(SECRET, ID, TS, BODY);
    expect(() => verifyStandardWebhook(BODY, headers(`v1,${sig}`), SECRET, NOW)).not.toThrow();
  });

  it('accepts the whsec_-prefixed secret form', () => {
    const sig = signStandardWebhook(`whsec_${SECRET}`, ID, TS, BODY);
    expect(() =>
      verifyStandardWebhook(BODY, headers(`v1,${sig}`), `whsec_${SECRET}`, NOW)
    ).not.toThrow();
    // both forms produce the same signature
    expect(sig).toBe(signStandardWebhook(SECRET, ID, TS, BODY));
  });

  it('accepts a matching signature among several space-separated ones', () => {
    const sig = signStandardWebhook(SECRET, ID, TS, BODY);
    const other = signStandardWebhook(SECRET, 'other', TS, BODY);
    expect(() =>
      verifyStandardWebhook(BODY, headers(`v1,${other} v1,${sig}`), SECRET, NOW)
    ).not.toThrow();
  });

  it('rejects a tampered body', () => {
    const sig = signStandardWebhook(SECRET, ID, TS, BODY);
    expect(() => verifyStandardWebhook(`${BODY} `, headers(`v1,${sig}`), SECRET, NOW)).toThrow(
      StandardWebhookVerificationError
    );
  });

  it('rejects a wrong secret', () => {
    const sig = signStandardWebhook(Buffer.from('wrong-secret').toString('base64'), ID, TS, BODY);
    expect(() => verifyStandardWebhook(BODY, headers(`v1,${sig}`), SECRET, NOW)).toThrow(
      StandardWebhookVerificationError
    );
  });

  it('rejects missing headers', () => {
    expect(() =>
      verifyStandardWebhook(BODY, { id: null, timestamp: TS, signature: 'v1,x' }, SECRET, NOW)
    ).toThrow(StandardWebhookVerificationError);
  });

  it('rejects a stale timestamp (replay window)', () => {
    const staleTs = String(NOW - 6 * 60);
    const sig = signStandardWebhook(SECRET, ID, staleTs, BODY);
    expect(() =>
      verifyStandardWebhook(BODY, headers(`v1,${sig}`, ID, staleTs), SECRET, NOW)
    ).toThrow(StandardWebhookVerificationError);
  });

  it('ignores non-v1 signature entries', () => {
    const sig = signStandardWebhook(SECRET, ID, TS, BODY);
    expect(() => verifyStandardWebhook(BODY, headers(`v2,${sig}`), SECRET, NOW)).toThrow(
      StandardWebhookVerificationError
    );
  });
});
