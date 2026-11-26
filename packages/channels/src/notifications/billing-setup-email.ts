import { escapeHtml } from '../form/notification-email.js';
import { renderZendoriEmail, type ZendoriMailDetail } from '../email/brand-mail.js';

// E-mail asking the owners and admins of an organization to set up billing
// (migration 0044): sent once when the operator switches the organization to
// Stripe billing, and again when the operator asks for it.
//
// With Stripe billing both are REQUIRED (owner decision 2026-11-27): billing
// details and a payment method (SEPA direct debit or card). Customers who are
// not billed through Stripe are invoiced by hand and never get this mail.
//
// Data minimisation: the mail names the organization and what is still missing
// and links to the billing page. No amounts, no usage, no message contents.

export interface BillingSetupEmailInput {
  orgName: string;
  /** Complete billing details are on file. */
  hasDetails: boolean;
  /** A payment method is on file. */
  hasPaymentMethod: boolean;
  /** First month that is invoiced through Stripe, e.g. "Dezember 2026"; null = unknown. */
  firstMonthLabel: string | null;
  /** Link to Einstellungen → Abrechnung of this organization. */
  openUrl: string;
  appUrl: string;
  /** false = Stripe test mode: nothing is charged. */
  livemode: boolean;
}

/** One line, no control characters, bounded length. */
function oneLine(value: string, max = 120): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

export function renderBillingSetupEmail(input: BillingSetupEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const orgName = oneLine(input.orgName);
  const org = escapeHtml(orgName);

  // what the customer is asked to do, in words
  const ask =
    !input.hasDetails && !input.hasPaymentMethod
      ? 'Rechnungsdaten und Zahlungsart'
      : !input.hasDetails
        ? 'Rechnungsdaten'
        : 'Zahlungsart';
  const subject = `Bitte ${ask} für ${orgName} hinterlegen`;

  const from = input.firstMonthLabel ? ` ab ${escapeHtml(input.firstMonthLabel)}` : '';
  const paragraphs = [
    `die Abrechnung von Zendori für <strong>${org}</strong> läuft${from} über unseren Zahlungsanbieter Stripe. Bitte hinterlegen Sie dafür ${ask === 'Zahlungsart' ? 'eine Zahlungsart' : ask === 'Rechnungsdaten' ? 'Ihre Rechnungsdaten' : 'Ihre Rechnungsdaten und eine Zahlungsart'}.`,
    'Als Zahlungsart sind SEPA-Lastschrift und Karte möglich. IBAN oder Kartennummer geben Sie direkt bei Stripe ein; Zendori speichert davon nur die Art und die letzten vier Stellen.',
    'Rechnungsdaten und Zahlungsart sind für die Abrechnung erforderlich. Ihre Rechnungen ziehen wir dann automatisch von der hinterlegten Zahlungsart ein.',
  ];

  const details: ZendoriMailDetail[] = [
    { label: 'Organisation', value: orgName },
    { label: 'Rechnungsdaten', value: input.hasDetails ? 'hinterlegt' : 'fehlen noch' },
    { label: 'Zahlungsart', value: input.hasPaymentMethod ? 'hinterlegt' : 'fehlt noch' },
  ];

  const { html, text } = renderZendoriEmail({
    preheader: `Bitte ${ask} für die Abrechnung von ${orgName} hinterlegen.`,
    paragraphs,
    details,
    cta: { label: 'Zur Abrechnung in Zendori', url: input.openUrl },
    ...(input.livemode
      ? {}
      : { notice: 'Testmodus: Hier hinterlegte Zahlungsarten werden nicht belastet.' }),
    footerNote:
      'Sie erhalten diese E-Mail, weil Sie Inhaber oder Admin dieser Organisation in Zendori sind.',
    appUrl: input.appUrl,
  });

  return { subject: input.livemode ? subject : `[Testmodus] ${subject}`, html, text };
}
