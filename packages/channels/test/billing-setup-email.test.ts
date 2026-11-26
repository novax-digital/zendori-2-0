import { describe, expect, it } from 'vitest';
import { renderBillingSetupEmail } from '../src/notifications/billing-setup-email.js';

// Migration 0044: the mail that asks owners and admins to set up billing.

const BASE = {
  orgName: 'Muster GmbH',
  hasDetails: false,
  hasPaymentMethod: false,
  firstMonthLabel: 'Dezember 2026',
  openUrl: 'https://app.example.com/settings/billing?org=o1',
  appUrl: 'https://app.example.com',
  livemode: true,
};

describe('renderBillingSetupEmail', () => {
  it('asks for exactly what is missing', () => {
    expect(renderBillingSetupEmail(BASE).subject).toBe(
      'Bitte Rechnungsdaten und Zahlungsart für Muster GmbH hinterlegen'
    );
    expect(renderBillingSetupEmail({ ...BASE, hasDetails: true }).subject).toBe(
      'Bitte Zahlungsart für Muster GmbH hinterlegen'
    );
    expect(renderBillingSetupEmail({ ...BASE, hasPaymentMethod: true }).subject).toBe(
      'Bitte Rechnungsdaten für Muster GmbH hinterlegen'
    );
  });

  it('links to the billing page and says that both are required', () => {
    const mail = renderBillingSetupEmail(BASE);
    expect(mail.text).toContain(BASE.openUrl);
    expect(mail.html).toContain('Zur Abrechnung in Zendori');
    expect(mail.text).toContain('ab Dezember 2026');
    expect(mail.text).toContain('sind für die Abrechnung erforderlich');
    // no way around it is offered any more
    expect(mail.text).not.toContain('Bezahllink');
    expect(mail.text).toContain('fehlen noch');
  });

  it('marks the test mode, and only the test mode', () => {
    expect(renderBillingSetupEmail(BASE).subject).not.toContain('Testmodus');
    const test = renderBillingSetupEmail({ ...BASE, livemode: false });
    expect(test.subject).toMatch(/^\[Testmodus\] /);
    expect(test.text).toContain('werden nicht belastet');
  });

  it('escapes the organization name and keeps it on one line', () => {
    const mail = renderBillingSetupEmail({ ...BASE, orgName: 'A <b>&</b>\nB', firstMonthLabel: null });
    expect(mail.html).not.toContain('<b>&</b>');
    expect(mail.subject).toBe('Bitte Rechnungsdaten und Zahlungsart für A <b>&</b> B hinterlegen');
    expect(mail.text).not.toContain(' ab ');
  });
});
