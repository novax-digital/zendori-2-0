import { describe, expect, it } from 'vitest';
import { computeTwilioSignature, verifyTwilioSignature } from '../src/whatsapp/twilio/signature.js';
import { parseTwilioInbound } from '../src/whatsapp/twilio/schemas.js';
import { normalizeWhatsAppTwilio, stripWhatsappPrefix } from '../src/whatsapp/twilio/normalize.js';
import { isWithinServiceWindow } from '../src/whatsapp/service-window.js';

describe('twilio signature', () => {
  // Reference vector cross-checked against an independent OpenSSL implementation
  // of the documented algorithm (url + sorted key+value concat, HMAC-SHA1, base64):
  //   printf '%s' 'https://mycompany.com/1234CallSidCA1234567890ABCDECaller+14158675309Digits1234From+14158675309To+18005551212' \
  //     | openssl dgst -sha1 -hmac 12345 -binary | base64
  const url = 'https://mycompany.com/1234';
  const params = {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+14158675309',
    Digits: '1234',
    From: '+14158675309',
    To: '+18005551212',
  };
  const authToken = '12345';
  const expected = 'RmhQFBI4A7vrrmHImJXMWMJEGZo=';

  it('matches an independent OpenSSL-computed signature', () => {
    expect(computeTwilioSignature(authToken, url, params)).toBe(expected);
  });

  it('verifies a correct signature', () => {
    expect(verifyTwilioSignature(authToken, url, params, expected)).toBe(true);
  });

  it('rejects a wrong signature', () => {
    expect(verifyTwilioSignature(authToken, url, params, 'wrong')).toBe(false);
    expect(verifyTwilioSignature(authToken, url, params, null)).toBe(false);
  });

  it('rejects when a param is tampered with', () => {
    expect(verifyTwilioSignature(authToken, url, { ...params, Digits: '9999' }, expected)).toBe(
      false
    );
  });

  it('is order-independent (params sorted by name)', () => {
    const reordered = {
      To: params.To,
      From: params.From,
      Digits: params.Digits,
      Caller: params.Caller,
      CallSid: params.CallSid,
    };
    expect(computeTwilioSignature(authToken, url, reordered)).toBe(expected);
  });
});

describe('twilio inbound parsing + normalize', () => {
  it('parses a text message and collapses no media', () => {
    const parsed = parseTwilioInbound({
      MessageSid: 'SM1111111111111111111111111111111',
      From: 'whatsapp:+491701234567',
      To: 'whatsapp:+493012345678',
      Body: 'Hallo',
      NumMedia: '0',
      ProfileName: 'Max',
      WaId: '491701234567',
    });
    expect(parsed).not.toBeNull();
    const msg = normalizeWhatsAppTwilio(parsed!, '2026-07-13T10:00:00.000Z');
    expect(msg.channelType).toBe('whatsapp');
    expect(msg.externalId).toBe('SM1111111111111111111111111111111'); // idempotency key
    expect(msg.contact.phone).toBe('+491701234567');
    expect(msg.contact.waId).toBe('491701234567');
    expect(msg.contact.name).toBe('Max');
    expect(msg.content).toBe('Hallo');
    expect(msg.contentType).toBe('text');
  });

  it('collapses indexed media params and picks an image content type', () => {
    const parsed = parseTwilioInbound({
      MessageSid: 'MM2222222222222222222222222222222',
      From: 'whatsapp:+491701234567',
      To: 'whatsapp:+493012345678',
      Body: '',
      NumMedia: '2',
      MediaUrl0: 'https://api.twilio.com/media/0',
      MediaContentType0: 'image/jpeg',
      MediaUrl1: 'https://api.twilio.com/media/1',
      MediaContentType1: 'application/pdf',
      WaId: '491701234567',
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.media).toHaveLength(2);
    const msg = normalizeWhatsAppTwilio(parsed!, '2026-07-13T10:00:00.000Z');
    expect(msg.contentType).toBe('image');
    const meta = msg.metadata.whatsapp as { media?: unknown[] };
    expect(meta.media).toHaveLength(2);
  });

  it('returns null for a payload without MessageSid', () => {
    expect(
      parseTwilioInbound({ From: 'whatsapp:+491701234567', To: 'whatsapp:+493012345678' })
    ).toBeNull();
  });

  it('strips the whatsapp: prefix', () => {
    expect(stripWhatsappPrefix('whatsapp:+491701234567')).toBe('+491701234567');
    expect(stripWhatsappPrefix('+491701234567')).toBe('+491701234567');
  });
});

describe('24h service window', () => {
  const now = Date.parse('2026-07-13T12:00:00.000Z');

  it('is inside the window for a recent inbound', () => {
    expect(isWithinServiceWindow('2026-07-13T00:00:00.000Z', now)).toBe(true);
  });

  it('is outside the window after 24h', () => {
    expect(isWithinServiceWindow('2026-07-12T11:00:00.000Z', now)).toBe(false);
  });

  it('is outside the window for null / invalid timestamps', () => {
    expect(isWithinServiceWindow(null, now)).toBe(false);
    expect(isWithinServiceWindow('not-a-date', now)).toBe(false);
  });
});
