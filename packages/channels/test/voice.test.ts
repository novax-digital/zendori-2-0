import { describe, expect, it } from 'vitest';
import { channelConfigSchema } from '../src/config.js';
import { sipHeaderNumber, xaiCallIncomingEventSchema } from '../src/voice/schemas.js';

describe('voice channel config', () => {
  it('parses an xAI voice config with defaults', () => {
    const config = channelConfigSchema.parse({
      type: 'voice',
      provider: 'xai',
      phoneNumber: '+493022334455',
      dispatchSigningSecretEncrypted: 'v1:nonce:cipher',
    });
    if (config.type !== 'voice') throw new Error('expected voice config');
    expect(config.voice).toBe('eve');
    expect(config.languageHint).toBe('de');
    expect(config.maxCallSeconds).toBe(900);
    // recording is a legal opt-in — MUST default to off
    expect(config.recordingEnabled).toBe(false);
  });

  it('accepts recordingEnabled true (owner opt-in)', () => {
    const config = channelConfigSchema.parse({
      type: 'voice',
      provider: 'xai',
      phoneNumber: '+493022334455',
      dispatchSigningSecretEncrypted: 'v1:nonce:cipher',
      recordingEnabled: true,
    });
    if (config.type !== 'voice') throw new Error('expected voice config');
    expect(config.recordingEnabled).toBe(true);
  });

  it('parses keyterms and transfer number, stripping legacy behavioral keys (0011)', () => {
    const config = channelConfigSchema.parse({
      type: 'voice',
      provider: 'xai',
      phoneNumber: '+493022334455',
      dispatchSigningSecretEncrypted: 'v1:nonce:cipher',
      // legacy keys from pre-0011 configs — must be stripped, not rejected
      agentMode: 'intake_only',
      instructions: 'alte Anweisungen',
      keyterms: ['Strong Energy', 'Wallbox'],
      transferNumber: '+491701112233',
    });
    if (config.type !== 'voice') throw new Error('expected voice config');
    expect(config.keyterms).toHaveLength(2);
    expect(config.transferNumber).toBe('+491701112233');
    expect('agentMode' in config).toBe(false);
    expect('instructions' in config).toBe(false);
  });

  it('rejects a voice config without the signing secret', () => {
    expect(() =>
      channelConfigSchema.parse({
        type: 'voice',
        provider: 'xai',
        phoneNumber: '+493022334455',
      })
    ).toThrow();
  });
});

describe('xAI incoming-call webhook schema', () => {
  it('parses the documented payload shape', () => {
    const event = xaiCallIncomingEventSchema.parse({
      object: 'event',
      id: 'evt_123',
      type: 'realtime.call.incoming',
      created_at: 1750000000,
      data: {
        call_id: 'a3a1f6a0-1111-2222-3333-444455556666',
        sip_headers: [
          { name: 'From', value: '+491701234567' },
          { name: 'To', value: '+493022334455' },
        ],
        metadata: {},
      },
    });
    expect(event.data.call_id).toContain('a3a1f6a0');
  });

  it('rejects other event types', () => {
    expect(() =>
      xaiCallIncomingEventSchema.parse({
        object: 'event',
        id: 'evt_1',
        type: 'realtime.call.ended',
        created_at: 1,
        data: { call_id: 'x' },
      })
    ).toThrow();
  });
});

describe('sipHeaderNumber', () => {
  const headers = (value: string) => [{ name: 'From', value }];

  it('parses a bare E.164', () => {
    expect(sipHeaderNumber(headers('+491701234567'), 'From')).toBe('+491701234567');
  });

  it('parses tel: and sip: wrappers', () => {
    expect(sipHeaderNumber(headers('tel:+491701234567'), 'from')).toBe('+491701234567');
    expect(sipHeaderNumber(headers('sip:+491701234567@sip.voice.x.ai;transport=tls'), 'From')).toBe(
      '+491701234567'
    );
  });

  it('parses a display-name form', () => {
    expect(sipHeaderNumber(headers('"Max" <sip:+491701234567@host>'), 'From')).toBe(
      '+491701234567'
    );
  });

  it('returns null for missing header or non-numbers', () => {
    expect(sipHeaderNumber([], 'From')).toBeNull();
    expect(sipHeaderNumber(headers('anonymous'), 'From')).toBeNull();
  });
});
