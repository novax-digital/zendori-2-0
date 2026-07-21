import { afterEach, describe, expect, it } from 'vitest';
import { escapeHtml, renderFormNotificationEmail } from '../src/form/notification-email.js';
import { isSuppressedEmailRecipient } from '../src/email/dispatch.js';

describe('renderFormNotificationEmail', () => {
  const base = {
    orgName: 'Strong Energy',
    formName: 'Kontaktformular',
    fields: [
      { label: 'Name', value: 'Max Muster' },
      { label: 'Nachricht', value: 'Zeile 1\nZeile 2' },
    ],
    consentText: 'Ich stimme zu.',
    conversationUrl: 'https://app.zendori.ai/inbox?conversation=abc',
    color: '#0bb8ba',
    submittedAt: new Date('2026-07-21T10:00:00Z'),
  };

  it('escapes HTML in attacker-controlled field values', () => {
    const rendered = renderFormNotificationEmail({
      ...base,
      fields: [{ label: 'Name', value: '<script>alert(1)</script> & "quotes"' }],
    });
    expect(rendered.html).not.toContain('<script>alert');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).toContain('&amp; &quot;quotes&quot;');
    // the text part keeps the raw value (no HTML context)
    expect(rendered.text).toContain('<script>alert(1)</script>');
  });

  it('renders subject, fields, consent and deep link', () => {
    const rendered = renderFormNotificationEmail(base);
    expect(rendered.subject).toBe('Neue Formular-Einsendung: Kontaktformular');
    expect(rendered.html).toContain('Max Muster');
    expect(rendered.html).toContain('Zeile 1<br />Zeile 2');
    expect(rendered.html).toContain('Ich stimme zu.');
    expect(rendered.html).toContain('https://app.zendori.ai/inbox?conversation=abc');
    expect(rendered.text).toContain('Name: Max Muster');
  });

  it('falls back to the brand color on invalid color values', () => {
    const rendered = renderFormNotificationEmail({
      ...base,
      color: 'red;background:url(evil)',
    });
    expect(rendered.html).toContain('#0bb8ba');
    expect(rendered.html).not.toContain('url(evil)');
  });

  it('escapeHtml covers the critical characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('isSuppressedEmailRecipient (mail-loop guard)', () => {
  afterEach(() => {
    delete process.env.INBOUND_EMAIL_DOMAIN;
  });

  it('blocks recipients under the inbound catch-all domain', () => {
    process.env.INBOUND_EMAIL_DOMAIN = 'in.zendori.de';
    expect(isSuppressedEmailRecipient('victim-kf-x1@in.zendori.de')).toBe(true);
    expect(isSuppressedEmailRecipient('  Someone@IN.ZENDORI.DE ')).toBe(true);
    expect(isSuppressedEmailRecipient('kunde@example.com')).toBe(false);
  });

  it('is inactive without the env (fail-open like the rest of the config)', () => {
    delete process.env.INBOUND_EMAIL_DOMAIN;
    expect(isSuppressedEmailRecipient('x@in.zendori.de')).toBe(false);
  });
});
