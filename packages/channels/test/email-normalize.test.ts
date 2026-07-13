import { describe, expect, it } from 'vitest';
import { normalizeReceivedEmail } from '../src/email/normalize.js';
import { resendInboundWebhookSchema, resendReceivedEmailSchema } from '../src/email/schemas.js';

const webhook = resendInboundWebhookSchema.parse({
  type: 'email.received',
  created_at: '2026-07-13T10:00:00.000Z',
  data: {
    email_id: '11111111-2222-3333-4444-555555555555',
    created_at: '2026-07-13T10:00:05.000Z',
    from: 'Acme <a@b.com>',
    to: ['strongenergy-kf-x7k2m9@in.zendori.ai'],
    received_for: ['strongenergy-kf-x7k2m9@in.zendori.ai'],
    message_id: '<original-webhook-id@b.com>',
    subject: 'Anfrage zur Wallbox',
  },
});

describe('normalizeReceivedEmail', () => {
  it('maps the documented payload to a UnifiedInboundMessage', () => {
    const fullEmail = resendReceivedEmailSchema.parse({
      html: '<p>Hallo &amp; guten Tag</p><p>meine Wallbox lädt nicht.</p>',
      text: 'Hallo & guten Tag\n\nmeine Wallbox lädt nicht.',
      subject: 'Anfrage zur Wallbox',
      from: '"Erika Musterfrau" <Erika@Example.COM>',
      to: ['strongenergy-kf-x7k2m9@in.zendori.ai'],
      headers: {
        'Message-ID': '<mail-abc@example.com>',
        'In-Reply-To': '<parent@in.zendori.ai>',
        References: '<root@in.zendori.ai> <parent@in.zendori.ai>',
      },
    });

    const msg = normalizeReceivedEmail(webhook, fullEmail);

    expect(msg.channelType).toBe('email');
    expect(msg.externalId).toBe('11111111-2222-3333-4444-555555555555');
    expect(msg.contact).toEqual({ name: 'Erika Musterfrau', email: 'erika@example.com' });
    expect(msg.contentType).toBe('html');
    expect(msg.content).toBe('Hallo & guten Tag\n\nmeine Wallbox lädt nicht.');
    expect(msg.receivedAt).toBe('2026-07-13T10:00:05.000Z');
    expect(msg.threadRef).toBe('<root@in.zendori.ai> <parent@in.zendori.ai>');

    const email = msg.metadata.email as Record<string, unknown>;
    expect(email.message_id).toBe('<mail-abc@example.com>');
    expect(email.in_reply_to).toBe('<parent@in.zendori.ai>');
    expect(email.references).toEqual(['<root@in.zendori.ai>', '<parent@in.zendori.ai>']);
    expect(email.from_raw).toBe('"Erika Musterfrau" <Erika@Example.COM>');
    expect(email.to).toEqual(['strongenergy-kf-x7k2m9@in.zendori.ai']);
    expect(email.stripped).toBe('Hallo & guten Tag\n\nmeine Wallbox lädt nicht.');
  });

  it('falls back to text and content_type text when no HTML is present', () => {
    const fullEmail = resendReceivedEmailSchema.parse({
      text: 'Nur Text hier.',
      subject: 'Kein HTML',
      from: 'a@b.com',
      to: ['strongenergy-kf-x7k2m9@in.zendori.ai'],
      headers: {},
    });

    const msg = normalizeReceivedEmail(webhook, fullEmail);
    expect(msg.contentType).toBe('text');
    expect(msg.content).toBe('Nur Text hier.');
    expect(msg.contact).toEqual({ email: 'a@b.com' });
    expect(msg.threadRef).toBeUndefined();
  });

  it('stores the reply-stripped body separately from the full content', () => {
    const body = [
      'Vielen Dank, das passt so.',
      '',
      'Am 12. März 2024 um 14:30 schrieb Support <support@firma.de>:',
      '> alte Nachricht',
    ].join('\n');
    const fullEmail = resendReceivedEmailSchema.parse({
      text: body,
      subject: 'Antwort',
      from: 'Kunde <kunde@example.com>',
      to: ['strongenergy-kf-x7k2m9@in.zendori.ai'],
      headers: { 'Message-ID': '<reply-1@example.com>' },
    });

    const msg = normalizeReceivedEmail(webhook, fullEmail);
    expect(msg.content).toBe(body);
    expect((msg.metadata.email as Record<string, unknown>).stripped).toBe(
      'Vielen Dank, das passt so.'
    );
  });

  it('uses the webhook message_id when the retrieved headers lack one', () => {
    const fullEmail = resendReceivedEmailSchema.parse({
      text: 'body',
      from: 'a@b.com',
      to: ['strongenergy-kf-x7k2m9@in.zendori.ai'],
      headers: {},
    });

    const msg = normalizeReceivedEmail(webhook, fullEmail);
    expect((msg.metadata.email as Record<string, unknown>).message_id).toBe(
      '<original-webhook-id@b.com>'
    );
  });
});
