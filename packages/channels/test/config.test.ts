import { describe, expect, it } from 'vitest';
import { channelConfigSchema } from '../src/config.js';

describe('channel config schemas', () => {
  it('parses an inbound email channel config', () => {
    const config = channelConfigSchema.parse({
      type: 'email',
      mode: 'inbound',
      address: 'strongenergy-kf-x7k2m9@in.zendori.de',
    });
    expect(config.type).toBe('email');
  });

  it('rejects an imap config without encrypted password', () => {
    expect(() =>
      channelConfigSchema.parse({
        type: 'email',
        mode: 'imap',
        imapHost: 'imap.example.com',
        imapPort: 993,
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        username: 'support@example.com',
      })
    ).toThrow();
  });

  it('rejects unknown channel types', () => {
    expect(() => channelConfigSchema.parse({ type: 'sms' })).toThrow();
  });

  it('parses a Twilio WhatsApp channel config', () => {
    const config = channelConfigSchema.parse({
      type: 'whatsapp',
      provider: 'twilio',
      sender: '+493012345678',
      accountSid: 'AC00000000000000000000000000000000',
      authTokenEncrypted: 'v1:nonce:cipher',
    });
    expect(config.type).toBe('whatsapp');
    // discriminated union → provider is narrowed
    if (config.type === 'whatsapp' && config.provider === 'twilio') {
      expect(config.connectionState).toBe('active'); // default applied
    } else {
      throw new Error('expected a twilio whatsapp config');
    }
  });

  it('parses a Meta WhatsApp channel config with the default graph version', () => {
    const config = channelConfigSchema.parse({
      type: 'whatsapp',
      provider: 'meta',
      phoneNumberId: '106540352242922',
      wabaId: '102290129340398',
      accessTokenEncrypted: 'v1:nonce:cipher',
    });
    if (config.type === 'whatsapp' && config.provider === 'meta') {
      expect(config.graphVersion).toBe('v25.0');
    } else {
      throw new Error('expected a meta whatsapp config');
    }
  });

  it('rejects a WhatsApp config without a provider', () => {
    expect(() =>
      channelConfigSchema.parse({
        type: 'whatsapp',
        sender: '+493012345678',
        accountSid: 'AC00000000000000000000000000000000',
        authTokenEncrypted: 'v1:nonce:cipher',
      })
    ).toThrow();
  });

  it('rejects a Twilio WhatsApp config missing the encrypted auth token', () => {
    expect(() =>
      channelConfigSchema.parse({
        type: 'whatsapp',
        provider: 'twilio',
        sender: '+493012345678',
        accountSid: 'AC00000000000000000000000000000000',
      })
    ).toThrow();
  });
});
