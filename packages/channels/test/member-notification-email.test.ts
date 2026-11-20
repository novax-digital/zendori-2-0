import { describe, expect, it } from 'vitest';
import { NOTIFICATION_EVENTS } from '@zendori/core';
import {
  renderMemberNotificationEmail,
  renderZendoriEmail,
  sampleMemberNotification,
  type MemberNotificationInput,
} from '../src/index.js';

// Templates of the member notifications (0038) and the shared branded layout.
// Pins: one template per event, customer-controlled values are escaped, the
// subject is a safe single line, and a test mail is clearly marked.

const base: MemberNotificationInput = {
  event: 'conversation.new',
  orgName: 'Acme GmbH',
  entityType: 'conversation',
  subject: 'Frage zur Rechnung',
  channelName: 'Website-Chat',
  contactName: 'Erika Mustermann',
  occurredAt: new Date('2026-11-20T09:30:00Z'),
  openUrl: 'https://app.example.com/inbox?org=o1&conversation=c1',
  settingsUrl: 'https://app.example.com/settings/notifications?org=o1',
  appUrl: 'https://app.example.com',
};

describe('renderMemberNotificationEmail', () => {
  it('new conversation: subject, details, link and the reason for the mail', () => {
    const mail = renderMemberNotificationEmail(base);
    expect(mail.subject).toBe('Neue Konversation: Frage zur Rechnung');
    expect(mail.html).toContain('Acme GmbH');
    expect(mail.html).toContain('Erika Mustermann');
    expect(mail.html).toContain('Website-Chat');
    expect(mail.html).toContain('https://app.example.com/inbox?org=o1&amp;conversation=c1');
    expect(mail.html).toContain('Benachrichtigungen verwalten');
    expect(mail.html).toContain('„Neue Konversation“');
    expect(mail.text).toContain('Betreff: Frage zur Rechnung');
    expect(mail.text).toContain(
      'In Zendori öffnen: https://app.example.com/inbox?org=o1&conversation=c1'
    );
    // 09:30 UTC is 10:30 in Berlin (winter)
    expect(mail.text).toContain('10:30');
  });

  it('falls back to the contact, then to a plain subject', () => {
    expect(renderMemberNotificationEmail({ ...base, subject: null }).subject).toBe(
      'Neue Konversation von Erika Mustermann'
    );
    expect(
      renderMemberNotificationEmail({ ...base, subject: null, contactName: null }).subject
    ).toBe('Neue Konversation');
  });

  it('new ticket names the ticket id', () => {
    const mail = renderMemberNotificationEmail({
      ...base,
      event: 'ticket.new',
      entityType: 'ticket',
      ticketDisplayId: 'T-1042',
      openUrl: 'https://app.example.com/tickets/t1?org=o1',
    });
    expect(mail.subject).toBe('Neues Ticket T-1042: Frage zur Rechnung');
    expect(mail.html).toContain('Ticket in Zendori öffnen');
    expect(mail.text).toContain('Ticket: T-1042');
  });

  it('handoff explains why the agent handed over', () => {
    const mail = renderMemberNotificationEmail({
      ...base,
      event: 'handoff.pending',
      handoffReason: 'user_request',
    });
    expect(mail.subject).toBe('Wartet auf einen Mitarbeiter: Frage zur Rechnung');
    expect(mail.text).toContain('Grund: Der Kunde möchte mit einem Menschen sprechen');
    // an unknown reason is simply left out
    const other = renderMemberNotificationEmail({
      ...base,
      event: 'handoff.pending',
      handoffReason: 'something_new',
    });
    expect(other.text).not.toContain('Grund:');
  });

  it('assignment distinguishes ticket and conversation', () => {
    expect(
      renderMemberNotificationEmail({
        ...base,
        event: 'assigned',
        entityType: 'ticket',
        ticketDisplayId: 'T-7',
      }).subject
    ).toBe('Ihnen zugewiesen: Ticket T-7 — Frage zur Rechnung');
    expect(renderMemberNotificationEmail({ ...base, event: 'assigned' }).subject).toBe(
      'Ihnen zugewiesen: Konversation — Frage zur Rechnung'
    );
  });

  it('escapes customer-controlled values and keeps the subject on one line', () => {
    const mail = renderMemberNotificationEmail({
      ...base,
      subject: 'Hallo <script>alert(1)</script>\r\nBcc: x@example.com',
      contactName: '"><img src=x onerror=alert(1)>',
      orgName: 'A & B <GmbH>',
    });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).toContain('A &amp; B &lt;GmbH&gt;');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('truncates an overlong subject', () => {
    const mail = renderMemberNotificationEmail({ ...base, subject: 'x'.repeat(500) });
    expect(mail.subject.length).toBeLessThanOrEqual(160);
    expect(mail.subject.endsWith('…')).toBe(true);
  });

  it('works without links (app URL unknown)', () => {
    const mail = renderMemberNotificationEmail({ ...base, openUrl: null, settingsUrl: null });
    expect(mail.html).not.toContain('In Zendori öffnen');
    expect(mail.html).not.toContain('Benachrichtigungen verwalten');
  });
});

describe('sampleMemberNotification (test mail)', () => {
  it('renders every event as a marked test mail with sample data', () => {
    for (const event of NOTIFICATION_EVENTS) {
      const mail = renderMemberNotificationEmail(
        sampleMemberNotification(event, {
          orgName: 'Acme GmbH',
          appUrl: 'https://app.example.com/',
          orgId: '11111111-1111-4111-8111-111111111111',
          now: new Date('2026-11-20T09:30:00Z'),
        })
      );
      expect(mail.subject.startsWith('[Test] ')).toBe(true);
      expect(mail.html).toContain('Testmail mit Beispielinhalt');
      expect(mail.text).toContain('[Testmail mit Beispielinhalt');
      expect(mail.html).toContain('Erika Mustermann');
      expect(mail.html).toContain(
        'https://app.example.com/settings/notifications?org=11111111-1111-4111-8111-111111111111'
      );
      expect(mail.html).not.toContain('app.example.com//');
    }
  });
});

describe('renderZendoriEmail (shared layout)', () => {
  it('stays unchanged for mails without the new blocks', () => {
    const mail = renderZendoriEmail({
      preheader: 'Vorschau',
      paragraphs: ['Ein <strong>Absatz</strong>.'],
      cta: { label: 'Öffnen', url: 'https://app.example.com/x' },
      finePrint: 'Kleingedrucktes',
      appUrl: 'https://app.example.com',
    });
    expect(mail.html).toContain('Guten Tag,');
    expect(mail.html).toContain('Ein <strong>Absatz</strong>.');
    expect(mail.html).not.toContain(
      'role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px'
    );
    expect(mail.text).toContain('Öffnen: https://app.example.com/x');
    expect(mail.text).toContain('Kleingedrucktes');
  });

  it('renders detail rows escaped and skips empty values', () => {
    const mail = renderZendoriEmail({
      preheader: 'p',
      paragraphs: [],
      details: [
        { label: 'Betreff', value: '<b>fett</b>' },
        { label: 'Leer', value: '   ' },
      ],
      notice: 'Hinweis <x>',
      appUrl: 'https://app.example.com',
    });
    expect(mail.html).toContain('&lt;b&gt;fett&lt;/b&gt;');
    expect(mail.html).not.toContain('Leer');
    expect(mail.html).toContain('Hinweis &lt;x&gt;');
    expect(mail.text).toContain('Betreff: <b>fett</b>');
  });
});
