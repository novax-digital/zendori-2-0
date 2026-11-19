import { describe, expect, it } from 'vitest';
import {
  classifyVerifyCheck,
  classifyVerifySendError,
  demoVerifyChannelFor,
  maskDemoPhone,
  normalizeDemoPhone,
  normalizeDemoWebsite,
  toPublicDemoStatus,
  validateDemoLead,
} from '../src/demo.js';

describe('normalizeDemoPhone', () => {
  it.each([
    ['0170 1234567', '+491701234567'],
    ['+49 (0) 170 / 123-4567', '+491701234567'],
    ['0049 511 1234567', '+495111234567'],
    ['030 22334455', '+493022334455'],
    ['+49 32 123456789', '+4932123456789'],
  ])('accepts %s', (raw, e164) => {
    expect(normalizeDemoPhone(raw)).toEqual({ ok: true, e164 });
  });

  it.each([
    '0900 1234567', // premium
    '0180 5123456', // service
    '0137 1234567', // mass calling
    '0118 33', // directory (also too short → still not allowed/invalid)
    '0700 12345678', // personal number
    '0800 1234567', // free-phone
    '01033 0301234567', // call-by-call
    '+43 1 2345678', // foreign
    '0043 1 2345678', // foreign
  ])('rejects %s', (raw) => {
    expect(normalizeDemoPhone(raw).ok).toBe(false);
  });

  it('distinguishes foreign (not_allowed) from garbage (invalid)', () => {
    expect(normalizeDemoPhone('+43 1 2345678')).toEqual({ ok: false, reason: 'not_allowed' });
    expect(normalizeDemoPhone('hallo')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeDemoPhone('170 1234567')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeDemoPhone('0170 123')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('normalizeDemoWebsite', () => {
  it('adds https and keeps http(s)', () => {
    expect(normalizeDemoWebsite('www.beispiel.de')).toBe('https://www.beispiel.de/');
    expect(normalizeDemoWebsite('http://beispiel.de/a')).toBe('http://beispiel.de/a');
    expect(normalizeDemoWebsite('  ')).toBeNull();
  });

  it('rejects non-http schemes, credentials and bare hosts', () => {
    expect(normalizeDemoWebsite('ftp://beispiel.de')).toBe('invalid');
    expect(normalizeDemoWebsite('https://user:pw@beispiel.de')).toBe('invalid');
    expect(normalizeDemoWebsite('localhost')).toBe('invalid');
  });
});

describe('validateDemoLead', () => {
  const valid = {
    company: '  Müller   Haustechnik ',
    contactName: 'Anna Müller',
    email: 'Anna@Mueller.de',
    phone: '0170 1234567',
    websiteUrl: '',
    prompt: 'Ruf mich an\r\nals Kunde.',
  };

  it('normalizes a valid lead', () => {
    const result = validateDemoLead(valid, { requireEmail: true });
    expect(result).toEqual({
      ok: true,
      lead: {
        company: 'Müller Haustechnik',
        contactName: 'Anna Müller',
        email: 'anna@mueller.de',
        phoneE164: '+491701234567',
        websiteUrl: null,
        prompt: 'Ruf mich an\nals Kunde.',
      },
    });
  });

  it('reports field errors in German', () => {
    const result = validateDemoLead(
      { ...valid, company: 'A', email: 'kaputt', phone: '0900 123456', websiteUrl: 'ftp://x.de' },
      { requireEmail: true }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(['company', 'email', 'phone', 'websiteUrl']);
      expect(result.errors.phone).toContain('Sonder');
    }
  });

  it('makes the e-mail optional for admin demos', () => {
    expect(validateDemoLead({ ...valid, email: '' }, { requireEmail: false }).ok).toBe(true);
    expect(validateDemoLead({ ...valid, email: '' }, { requireEmail: true }).ok).toBe(false);
  });
});

describe('demo status helpers', () => {
  it('collapses internal states for the public surface', () => {
    expect(toPublicDemoStatus('preparing')).toBe('queued');
    expect(toPublicDemoStatus('dialing')).toBe('calling');
    expect(toPublicDemoStatus('connecting')).toBe('calling');
    expect(toPublicDemoStatus('in_call')).toBe('in_call');
  });

  it('masks phone numbers', () => {
    expect(maskDemoPhone('+491701234567')).toBe('+49 170 ••••• 67');
  });
});

describe('demo phone verification', () => {
  it('sends an SMS to mobiles and a voice code to landlines', () => {
    expect(demoVerifyChannelFor('+491701234567')).toBe('sms');
    expect(demoVerifyChannelFor('+491521234567')).toBe('sms');
    expect(demoVerifyChannelFor('+495111234567')).toBe('call');
    expect(demoVerifyChannelFor('+493022334455')).toBe('call');
  });

  it('maps Twilio Verify send errors', () => {
    expect(classifyVerifySendError(400, 60205)).toBe('landline');
    expect(classifyVerifySendError(400, 60200)).toBe('invalid_number');
    expect(classifyVerifySendError(429, 60203)).toBe('rate_limited');
    expect(classifyVerifySendError(403, 60410)).toBe('blocked');
    expect(classifyVerifySendError(429, null)).toBe('rate_limited');
    expect(classifyVerifySendError(500, null)).toBe('unavailable');
  });

  it('maps Twilio Verify check results', () => {
    expect(classifyVerifyCheck(200, { status: 'approved' })).toBe('approved');
    expect(classifyVerifyCheck(200, { status: 'pending' })).toBe('wrong_code');
    expect(classifyVerifyCheck(404, { code: 20404 })).toBe('code_expired');
    expect(classifyVerifyCheck(429, { code: 60202 })).toBe('max_attempts');
    expect(classifyVerifyCheck(500, null)).toBe('unavailable');
  });
});
