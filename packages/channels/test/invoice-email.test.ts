import { describe, expect, it } from 'vitest';
import { renderInvoiceEmail } from '../src/notifications/invoice-email.js';

// Phase 15b: the mail that carries an invoice.

const BASE = {
  kind: 'invoice' as const,
  number: 'ZD-2026-0001',
  periodLabel: 'November 2026',
  grossText: '72,38 €',
  dueDateText: '15.12.2026',
  recipientName: 'Muster GmbH',
  sellerName: 'Novax Digital GmbH',
  openUrl: 'https://app.example.com/settings/billing?org=o1',
  appUrl: 'https://app.example.com',
};

describe('renderInvoiceEmail', () => {
  it('names the invoice, the amount and when it is due', () => {
    const mail = renderInvoiceEmail(BASE);
    expect(mail.subject).toBe('Ihre Rechnung ZD-2026-0001 für November 2026');
    expect(mail.text).toContain('ZD-2026-0001');
    expect(mail.text).toContain('72,38 €');
    expect(mail.text).toContain('bis zum 15.12.2026');
    expect(mail.text).toContain(BASE.openUrl);
    expect(mail.html).toContain('Rechnungen in Zendori ansehen');
  });

  it('leaves the due date out when there is none', () => {
    const mail = renderInvoiceEmail({ ...BASE, dueDateText: null });
    expect(mail.text).not.toContain('bis zum');
    expect(mail.text).not.toContain('Fällig am');
  });

  it('a cancellation says what it cancels and asks for nothing', () => {
    const mail = renderInvoiceEmail({
      ...BASE,
      kind: 'cancellation',
      number: 'ZD-2026-0002',
      grossText: '-72,38 €',
      dueDateText: null,
      cancelsNumber: 'ZD-2026-0001',
    });
    expect(mail.subject).toBe('Stornorechnung ZD-2026-0002 zur Rechnung ZD-2026-0001');
    expect(mail.text).toContain('hebt die Rechnung ZD-2026-0001');
    expect(mail.text).not.toContain('überweisen');
  });

  it('escapes what comes from stored data and works without a link', () => {
    const mail = renderInvoiceEmail({
      ...BASE,
      number: 'ZD<b>-1',
      periodLabel: 'Nov <i>2026</i>',
      openUrl: null,
    });
    expect(mail.html).not.toContain('<b>-1');
    expect(mail.html).not.toContain('<i>2026</i>');
    expect(mail.html).not.toContain('Rechnungen in Zendori ansehen');
  });
});
