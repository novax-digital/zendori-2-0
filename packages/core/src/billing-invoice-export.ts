// Export of issued invoices for the bookkeeping (Phase 15b): one CSV row per
// invoice document — invoices and cancellations alike — with the frozen
// customer details and amounts plus where the payment stands. Pure.
//
// The file is made for German Excel: semicolons, decimal comma, dates as
// TT.MM.JJJJ, UTF-8 with a byte order mark, CRLF line ends.
import {
  INVOICE_DISPLAY_STATUS_LABELS,
  berlinDate,
  formatDateDe,
  invoiceDisplayStatus,
  type BillingInvoice,
  type InvoiceCollectState,
  type InvoicePaymentMethod,
} from './billing-invoice.js';

/** `all` = every invoice; otherwise the month of the invoice date, `YYYY-MM`. */
export type InvoiceExportRange = 'all' | string;

export function isInvoiceExportRange(value: string): boolean {
  return value === 'all' || /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** "Rechnungen-2026-11" or "Rechnungen-gesamt" — without the file ending. */
export function invoiceExportBaseName(range: InvoiceExportRange): string {
  return `Rechnungen-${range === 'all' ? 'gesamt' : range}`;
}

const PAYMENT_METHOD_LABELS: Record<InvoicePaymentMethod, string> = {
  transfer: 'Überweisung',
  sepa_debit: 'SEPA-Lastschrift',
  card: 'Karte',
};

const COLLECT_STATE_LABELS: Record<InvoiceCollectState, string> = {
  none: '',
  scheduled: 'geplant',
  processing: 'läuft',
  succeeded: 'eingezogen',
  failed: 'fehlgeschlagen',
  disputed: 'zurückgebucht',
};

export const INVOICE_CSV_HEADERS = [
  'Rechnungsnummer',
  'Art',
  'Rechnungsdatum',
  'Leistung von',
  'Leistung bis',
  'Fällig am',
  'Kunde',
  'Adresse',
  'Adresszusatz',
  'PLZ',
  'Ort',
  'Land',
  'USt-ID',
  'Rechnungs-E-Mail',
  'Netto (EUR)',
  'Steuersatz (%)',
  'Steuer (EUR)',
  'Brutto (EUR)',
  'Steuerart',
  'Status',
  'Bezahlt am',
  'Bezahlt über',
  'Zahlungsnotiz',
  'Zahlungsart',
  'Einzug ab',
  'Einzug',
  'Storno zu Rechnung',
  'Storniert durch',
  'Kunden-ID',
] as const;

/** 12345 → "123,45", -11900 → "-119,00": a number Excel reads, without a currency sign. */
export function centsToCsvAmount(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  const euros = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${euros},${rest}`;
}

/**
 * A text cell. A value a spreadsheet would run as a formula (it starts with
 * `=`, `+`, `-`, `@`, a tab or a line break — customers choose their own
 * company name) gets a leading apostrophe; quotes when the separator, a quote
 * or a line break is inside.
 */
export function csvText(value: string | null | undefined): string {
  let text = (value ?? '').replace(/\r\n?/g, '\n');
  if (/^[=+\-@\t\n]/.test(text)) text = `'${text}`;
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const date = (iso: string | null): string => (iso ? formatDateDe(iso) : '');
/** A point in time, as the day it was in Germany. */
const day = (timestamp: string | null): string => {
  if (!timestamp) return '';
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? '' : formatDateDe(berlinDate(parsed));
};

function servicePeriod(period: string): { from: string; to: string } {
  const [year, month] = period.split('-').map(Number) as [number, number];
  if (!year || !month) return { from: '', to: '' };
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { from: `01.${mm}.${year}`, to: `${String(lastDay).padStart(2, '0')}.${mm}.${year}` };
}

export interface InvoiceCsvOptions {
  /** Today in Germany (`YYYY-MM-DD`), for "Überfällig". */
  today: string;
  /**
   * Invoice id → number, for the two columns that point at another invoice.
   * The invoices passed in are looked up by themselves; this adds those outside
   * the export (a cancellation in another month).
   */
  numbers?: ReadonlyMap<string, string>;
}

/** The CSV file as text, starting with the byte order mark. */
export function invoiceCsv(invoices: readonly BillingInvoice[], options: InvoiceCsvOptions): string {
  const numbers = new Map<string, string>(options.numbers ?? []);
  for (const invoice of invoices) numbers.set(invoice.id, invoice.number);
  const numberOf = (id: string | null): string => (id ? (numbers.get(id) ?? '') : '');

  const rows = invoices.map((invoice) => {
    const service = servicePeriod(invoice.period);
    const isInvoice = invoice.kind === 'invoice';
    return [
      csvText(invoice.number),
      isInvoice ? 'Rechnung' : 'Stornorechnung',
      date(invoice.issueDate),
      service.from,
      service.to,
      isInvoice ? date(invoice.dueDate) : '',
      csvText(invoice.recipient.legalName),
      csvText(invoice.recipient.addressLine1),
      csvText(invoice.recipient.addressLine2),
      csvText(invoice.recipient.postalCode),
      csvText(invoice.recipient.city),
      csvText(invoice.recipient.country),
      csvText(invoice.recipient.vatId),
      csvText(invoice.recipient.billingEmail),
      centsToCsvAmount(invoice.netCents),
      String(invoice.taxPercent).replace('.', ','),
      centsToCsvAmount(invoice.taxCents),
      centsToCsvAmount(invoice.grossCents),
      invoice.taxMode === 'eu_reverse_charge' ? 'Reverse Charge' : 'Umsatzsteuer',
      INVOICE_DISPLAY_STATUS_LABELS[invoiceDisplayStatus(invoice, options.today)],
      day(invoice.paidAt),
      invoice.paidVia === 'stripe' ? 'Stripe' : invoice.paidVia === 'manual' ? 'Von Hand' : '',
      csvText(invoice.paidNote),
      isInvoice ? PAYMENT_METHOD_LABELS[invoice.paymentMethod] : '',
      isInvoice ? date(invoice.collectOn) : '',
      isInvoice ? COLLECT_STATE_LABELS[invoice.collectState] : '',
      csvText(numberOf(invoice.cancelsInvoiceId)),
      csvText(numberOf(invoice.cancelledByInvoiceId)),
      invoice.orgId ?? '',
    ].join(';');
  });

  return `﻿${[INVOICE_CSV_HEADERS.join(';'), ...rows].join('\r\n')}\r\n`;
}
