import { describe, expect, it } from 'vitest';
import {
  getHeader,
  resendInboundWebhookSchema,
  resendReceivedEmailSchema,
  resendSendResponseSchema,
  RESEND_INBOUND_EVENT_TYPE,
} from '../src/email/schemas.js';

const inboundWebhook = {
  type: 'email.received',
  created_at: '2026-07-13T10:00:00.000Z',
  data: {
    email_id: '11111111-2222-3333-4444-555555555555',
    created_at: '2026-07-13T10:00:00.000Z',
    from: 'Acme <a@b.com>',
    to: ['strongenergy-kf-x7k2m9@in.zendori.ai'],
    cc: [],
    bcc: [],
    received_for: ['strongenergy-kf-x7k2m9@in.zendori.ai'],
    message_id: '<rfc-id@b.com>',
    subject: 'Anfrage',
    attachments: [
      {
        id: 'att-1',
        filename: 'a.png',
        content_type: 'image/png',
        content_disposition: 'inline',
        content_id: 'img001',
      },
    ],
  },
};

describe('resendInboundWebhookSchema', () => {
  it('parses the documented email.received payload', () => {
    const parsed = resendInboundWebhookSchema.parse(inboundWebhook);
    expect(parsed.type).toBe(RESEND_INBOUND_EVENT_TYPE);
    expect(parsed.data.email_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(parsed.data.received_for).toEqual(['strongenergy-kf-x7k2m9@in.zendori.ai']);
    expect(parsed.data.attachments).toHaveLength(1);
  });

  it('accepts other event types (route decides to ignore them)', () => {
    const parsed = resendInboundWebhookSchema.parse({
      type: 'email.delivered',
      data: { email_id: 'abc' },
    });
    expect(parsed.type).toBe('email.delivered');
    expect(parsed.data.email_id).toBe('abc');
  });

  it('rejects a payload without an email_id', () => {
    expect(() => resendInboundWebhookSchema.parse({ type: 'email.received', data: {} })).toThrow();
  });

  it('strips unknown top-level keys without failing', () => {
    const parsed = resendInboundWebhookSchema.parse({
      ...inboundWebhook,
      extra_field: 'ignored',
    });
    expect('extra_field' in parsed).toBe(false);
  });
});

describe('resendReceivedEmailSchema', () => {
  it('lowercases header keys so lookups are case-insensitive', () => {
    const parsed = resendReceivedEmailSchema.parse({
      html: '<p>Hi</p>',
      text: 'Hi',
      subject: 'Re: Anfrage',
      from: 'Acme <a@b.com>',
      to: ['strongenergy-kf-x7k2m9@in.zendori.ai'],
      headers: {
        'Message-ID': '<rfc-id@b.com>',
        'In-Reply-To': '<parent@b.com>',
        References: '<root@b.com> <parent@b.com>',
      },
      attachments: [{ id: 'att-1', filename: 'a.png', content_type: 'image/png', size: 1234 }],
    });
    expect(getHeader(parsed.headers, 'message-id')).toBe('<rfc-id@b.com>');
    expect(getHeader(parsed.headers, 'MESSAGE-ID')).toBe('<rfc-id@b.com>');
    expect(getHeader(parsed.headers, 'references')).toBe('<root@b.com> <parent@b.com>');
    expect(getHeader(parsed.headers, 'x-missing')).toBeUndefined();
  });

  it('joins repeated (array) header values with a space', () => {
    const parsed = resendReceivedEmailSchema.parse({
      headers: { Received: ['by a', 'by b'] },
    });
    expect(getHeader(parsed.headers, 'received')).toBe('by a by b');
  });

  it('defaults headers to an empty object when omitted', () => {
    const parsed = resendReceivedEmailSchema.parse({ text: 'body only' });
    expect(parsed.headers).toEqual({});
    expect(getHeader(parsed.headers, 'message-id')).toBeUndefined();
  });
});

describe('resendSendResponseSchema', () => {
  it('parses the send response id', () => {
    expect(resendSendResponseSchema.parse({ id: 'sent-123' }).id).toBe('sent-123');
  });

  it('rejects a response without an id', () => {
    expect(() => resendSendResponseSchema.parse({})).toThrow();
  });
});

describe('getHeader', () => {
  it('returns undefined for an undefined header record', () => {
    expect(getHeader(undefined, 'message-id')).toBeUndefined();
  });
});
