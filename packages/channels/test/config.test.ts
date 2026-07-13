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
});
