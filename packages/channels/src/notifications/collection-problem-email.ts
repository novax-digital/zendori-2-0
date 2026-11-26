import { escapeHtml } from '../form/notification-email.js';
import { renderZendoriEmail, type ZendoriMailDetail } from '../email/brand-mail.js';

// The e-mail that tells the OPERATOR that collecting an invoice did not work
// (Phase 15b step 3): the charge failed, or a payment that went through was
// reversed. There is no automatic second attempt — the operator decides.

export interface CollectionProblemEmailInput {
  kind: 'failed' | 'disputed';
  number: string;
  customerName: string;
  /** "72,38 €" (gross) */
  grossText: string;
  /** In words, e.g. "Konto nicht gedeckt". */
  reasonText: string;
  /** Link to Plattform → Rechnungen; null when the app URL is unknown. */
  openUrl: string | null;
  appUrl: string;
  /** false = Stripe test mode. */
  livemode: boolean;
}

export function renderCollectionProblemEmail(input: CollectionProblemEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const number = escapeHtml(input.number);
  const customer = escapeHtml(input.customerName);
  const disputed = input.kind === 'disputed';
  const subject = disputed
    ? `Rückbuchung: Rechnung ${input.number} (${input.customerName})`
    : `Einzug fehlgeschlagen: Rechnung ${input.number} (${input.customerName})`;

  const paragraphs = disputed
    ? [
        `die Zahlung der Rechnung <strong>${number}</strong> von ${customer} wurde zurückgebucht. Die Rechnung steht wieder auf „offen“.`,
        'Bitte kläre das mit dem Kunden. Einen neuen Einzug gibt es für diese Rechnung nicht automatisch.',
      ]
    : [
        `der Einzug der Rechnung <strong>${number}</strong> von ${customer} hat nicht funktioniert. Die Rechnung bleibt offen.`,
        'Es gibt keinen automatischen zweiten Versuch. Unter Plattform → Rechnungen kannst du den Einzug erneut anstoßen oder die Rechnung als bezahlt markieren, wenn der Kunde überwiesen hat.',
      ];

  const details: ZendoriMailDetail[] = [
    { label: 'Rechnung', value: input.number },
    { label: 'Kunde', value: input.customerName },
    { label: 'Betrag', value: input.grossText },
  ];
  if (!disputed) details.push({ label: 'Grund', value: input.reasonText });

  const { html, text } = renderZendoriEmail({
    preheader: disputed
      ? `Rückbuchung zu Rechnung ${input.number}`
      : `Einzug fehlgeschlagen bei Rechnung ${input.number}`,
    paragraphs,
    details,
    ...(input.openUrl ? { cta: { label: 'Rechnungen öffnen', url: input.openUrl } } : {}),
    ...(input.livemode ? {} : { notice: 'Testmodus: Es wurde kein echtes Geld bewegt.' }),
    footerNote: 'Du erhältst diese E-Mail als Rechnungssteller in Zendori.',
    appUrl: input.appUrl,
  });

  return { subject: input.livemode ? subject : `[Testmodus] ${subject}`, html, text };
}
