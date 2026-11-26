import { escapeHtml } from '../form/notification-email.js';
import { renderZendoriEmail, type ZendoriMailDetail } from '../email/brand-mail.js';

// The e-mail that carries an invoice (Phase 15b, migration 0046): sent by the
// worker to the customer's billing address, with the PDF attached. The mail
// names the document and its amount; everything else is on the PDF.

export interface InvoiceEmailInput {
  kind: 'invoice' | 'cancellation';
  number: string;
  /** "November 2026" */
  periodLabel: string;
  /** "72,38 €" (gross) */
  grossText: string;
  /** "15.12.2026"; null on a cancellation or when nothing is to pay. */
  dueDateText: string | null;
  /** For a cancellation: the number of the cancelled invoice. */
  cancelsNumber?: string | null;
  recipientName: string;
  sellerName: string;
  /** Link to Einstellungen → Abrechnung; null when the app URL is unknown. */
  openUrl: string | null;
  appUrl: string;
}

export function renderInvoiceEmail(input: InvoiceEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const number = escapeHtml(input.number);
  const period = escapeHtml(input.periodLabel);
  const cancellation = input.kind === 'cancellation';

  const subject = cancellation
    ? `Stornorechnung ${input.number} zur Rechnung ${input.cancelsNumber ?? ''}`.trim()
    : `Ihre Rechnung ${input.number} für ${input.periodLabel}`;

  const paragraphs = cancellation
    ? [
        `im Anhang erhalten Sie die Stornorechnung <strong>${number}</strong>. Sie hebt die Rechnung ${escapeHtml(input.cancelsNumber ?? '')} für ${period} vollständig auf.`,
        'Ein bereits gezahlter Betrag wird erstattet oder mit der nächsten Rechnung verrechnet.',
      ]
    : [
        `im Anhang erhalten Sie Ihre Rechnung <strong>${number}</strong> für die Nutzung von Zendori im ${period}.`,
        input.dueDateText
          ? `Bitte überweisen Sie den Rechnungsbetrag bis zum ${escapeHtml(input.dueDateText)}. Die Bankverbindung steht auf der Rechnung; als Verwendungszweck genügt die Rechnungsnummer.`
          : 'Die Bankverbindung steht auf der Rechnung; als Verwendungszweck genügt die Rechnungsnummer.',
      ];

  const details: ZendoriMailDetail[] = [
    { label: cancellation ? 'Stornorechnung' : 'Rechnungsnummer', value: input.number },
    { label: 'Leistungszeitraum', value: input.periodLabel },
    { label: cancellation ? 'Gutschrift' : 'Rechnungsbetrag', value: input.grossText },
  ];
  if (!cancellation && input.dueDateText) {
    details.push({ label: 'Fällig am', value: input.dueDateText });
  }

  const { html, text } = renderZendoriEmail({
    preheader: cancellation
      ? `Stornorechnung ${input.number}`
      : `Rechnung ${input.number} über ${input.grossText}`,
    paragraphs,
    details,
    ...(input.openUrl
      ? { cta: { label: 'Rechnungen in Zendori ansehen', url: input.openUrl } }
      : {}),
    footerNote: `Sie erhalten diese E-Mail als Rechnungsempfänger von ${input.recipientName} bei ${input.sellerName}.`,
    appUrl: input.appUrl,
  });

  return { subject, html, text };
}
