import { z } from 'zod';
import type { TaxMode } from './billing-tax.js';

// Own invoices (Phase 15b, migration 0046): the document Zendori issues itself
// for a customer and a month — whether the customer is billed through Stripe or
// not. Everything here is pure: what an invoice consists of, how its amounts
// are built, how its number is written. The database stores the result frozen
// (billing_invoices) and refuses later changes; a mistake is corrected by a
// cancellation document and a new invoice.
//
// No Node dependency: the admin pages import the number preview in the browser.

// --- the operator on the invoice (billing_seller) --------------------------------

/** The seller as stored and as frozen into every invoice. Empty string = not set. */
export const invoiceSellerSchema = z.object({
  legalName: z.string().trim().max(150),
  addressLine1: z.string().trim().max(200),
  addressLine2: z.string().trim().max(200),
  postalCode: z.string().trim().max(20),
  city: z.string().trim().max(100),
  country: z.string().trim().max(2),
  vatId: z.string().trim().max(40),
  taxNumber: z.string().trim().max(40),
  registerCourt: z.string().trim().max(100),
  registerNumber: z.string().trim().max(60),
  managingDirectors: z.string().trim().max(200),
  email: z.string().trim().max(254),
  phone: z.string().trim().max(60),
  website: z.string().trim().max(120),
  bankName: z.string().trim().max(120),
  iban: z.string().trim().max(42),
  bic: z.string().trim().max(20),
  footerNote: z.string().trim().max(500),
});
export type InvoiceSeller = z.infer<typeof invoiceSellerSchema>;

export const EMPTY_SELLER: InvoiceSeller = {
  legalName: '',
  addressLine1: '',
  addressLine2: '',
  postalCode: '',
  city: '',
  country: 'DE',
  vatId: '',
  taxNumber: '',
  registerCourt: '',
  registerNumber: '',
  managingDirectors: '',
  email: '',
  phone: '',
  website: '',
  bankName: '',
  iban: '',
  bic: '',
  footerNote: '',
};

/** billing_seller as stored (snake case, every text column nullable). */
export interface BillingSellerRow {
  legal_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  postal_code: string | null;
  city: string | null;
  country: string | null;
  vat_id: string | null;
  tax_number: string | null;
  register_court: string | null;
  register_number: string | null;
  managing_directors: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  bank_name: string | null;
  iban: string | null;
  bic: string | null;
  footer_note: string | null;
  invoice_number_format: string;
  invoice_number_start: number;
  payment_term_days: number;
  /** 0047; absent before the migration. */
  auto_invoice_from?: string | null;
}

export interface SellerSettings {
  seller: InvoiceSeller;
  numberFormat: string;
  numberStart: number;
  paymentTermDays: number;
  /**
   * First month (YYYY-MM) whose invoices are issued by the monthly run; null =
   * no automatic invoices (migration 0047).
   */
  autoInvoiceFrom: string | null;
}

export function sellerFromRow(row: BillingSellerRow | null): SellerSettings {
  const text = (value: string | null | undefined): string => (value ?? '').trim();
  return {
    seller: {
      legalName: text(row?.legal_name),
      addressLine1: text(row?.address_line1),
      addressLine2: text(row?.address_line2),
      postalCode: text(row?.postal_code),
      city: text(row?.city),
      country: text(row?.country) || 'DE',
      vatId: text(row?.vat_id),
      taxNumber: text(row?.tax_number),
      registerCourt: text(row?.register_court),
      registerNumber: text(row?.register_number),
      managingDirectors: text(row?.managing_directors),
      email: text(row?.email),
      phone: text(row?.phone),
      website: text(row?.website),
      bankName: text(row?.bank_name),
      iban: text(row?.iban),
      bic: text(row?.bic),
      footerNote: text(row?.footer_note),
    },
    numberFormat: row?.invoice_number_format ?? DEFAULT_INVOICE_NUMBER_FORMAT,
    numberStart: row?.invoice_number_start ?? 1,
    paymentTermDays: row?.payment_term_days ?? 14,
    autoInvoiceFrom:
      typeof row?.auto_invoice_from === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.auto_invoice_from)
        ? row.auto_invoice_from
        : null,
  };
}

export function sellerToRow(settings: SellerSettings): BillingSellerRow {
  const text = (value: string): string | null => (value.trim() === '' ? null : value.trim());
  const { seller } = settings;
  return {
    legal_name: text(seller.legalName),
    address_line1: text(seller.addressLine1),
    address_line2: text(seller.addressLine2),
    postal_code: text(seller.postalCode),
    city: text(seller.city),
    country: text(seller.country) ?? 'DE',
    vat_id: text(seller.vatId),
    tax_number: text(seller.taxNumber),
    register_court: text(seller.registerCourt),
    register_number: text(seller.registerNumber),
    managing_directors: text(seller.managingDirectors),
    email: text(seller.email),
    phone: text(seller.phone),
    website: text(seller.website),
    bank_name: text(seller.bankName),
    iban: text(seller.iban),
    bic: text(seller.bic),
    footer_note: text(seller.footerNote),
    invoice_number_format: settings.numberFormat,
    invoice_number_start: settings.numberStart,
    payment_term_days: settings.paymentTermDays,
    auto_invoice_from: settings.autoInvoiceFrom,
  };
}

/**
 * What still has to be filled in before an invoice may be issued, in words.
 * § 14 UStG: full name and address of the seller, tax number OR VAT id. The
 * bank details are needed because an invoice is paid by transfer unless the
 * amount is collected.
 */
export function sellerMissingFields(seller: InvoiceSeller): string[] {
  const missing: string[] = [];
  if (seller.legalName === '') missing.push('Firmenname');
  if (seller.addressLine1 === '') missing.push('Straße und Hausnummer');
  if (seller.postalCode === '') missing.push('PLZ');
  if (seller.city === '') missing.push('Ort');
  if (seller.vatId === '' && seller.taxNumber === '') missing.push('USt-ID oder Steuernummer');
  if (seller.email === '') missing.push('E-Mail');
  if (seller.iban === '') missing.push('IBAN');
  return missing;
}

// --- invoice number ---------------------------------------------------------------

export const DEFAULT_INVOICE_NUMBER_FORMAT = 'ZD-{YYYY}-{NNNN}';

/** A format needs a running number ({N…}); only harmless characters around it. */
export function isInvoiceNumberFormat(format: string): boolean {
  if (format.length === 0 || format.length > 40) return false;
  if (!/\{N+\}/.test(format)) return false;
  const rest = format.replace(/\{N+\}/, '').replace(/\{YYYY\}|\{YY\}/g, '');
  return /^[A-Za-z0-9\-_/.]*$/.test(rest);
}

/**
 * The number as the database writes it (issue_billing_invoice mirrors this):
 * {YYYY} / {YY} = year of issue, {NNNN} = running number padded to as many
 * digits as there are N's.
 */
export function formatInvoiceNumber(format: string, year: number, seq: number): string {
  const digits = /\{(N+)\}/.exec(format)?.[1]?.length ?? 1;
  return format
    .replace(/\{N+\}/, String(seq).padStart(Math.max(digits, String(seq).length), '0'))
    .replaceAll('{YYYY}', String(year))
    .replaceAll('{YY}', String(year % 100).padStart(2, '0'));
}

// --- the frozen document ----------------------------------------------------------

export const invoiceRecipientSchema = z.object({
  legalName: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().default(''),
  postalCode: z.string(),
  city: z.string(),
  country: z.string(),
  vatId: z.string().default(''),
  billingEmail: z.string().default(''),
});
export type InvoiceRecipient = z.infer<typeof invoiceRecipientSchema>;

export const invoiceLineSchema = z.object({
  label: z.string().min(1).max(200),
  /** How much was used, in words ("120 Minuten"); absent on fixed fees. */
  quantity: z.string().max(60).optional(),
  amountCents: z.number().int(),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

export const INVOICE_KINDS = ['invoice', 'cancellation'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const INVOICE_PAYMENT_STATUSES = ['open', 'paid', 'void'] as const;
export type InvoicePaymentStatus = (typeof INVOICE_PAYMENT_STATUSES)[number];

export interface InvoiceAmounts {
  lines: InvoiceLine[];
  netCents: number;
  taxCents: number;
  grossCents: number;
}

const toCents = (eur: number): number => Math.round(eur * 100);

/**
 * Turns the month as the app calculates it (fixed fees + usage, net EUR) into
 * the lines and totals of an invoice. Every line is rounded to cents first and
 * the net is their sum, so the document always adds up; the tax is calculated
 * once on the net (§ 14 UStG: one rate per invoice here). Lines of 0 € are left
 * out — an invoice lists what is charged.
 */
export function buildInvoiceAmounts(input: {
  fixed: { label: string; amountEur: number }[];
  usage: { label: string; quantity: string; amountEur: number }[];
  taxPercent: number;
}): InvoiceAmounts {
  const lines: InvoiceLine[] = [];
  for (const line of input.fixed) {
    const amountCents = toCents(line.amountEur);
    if (amountCents !== 0) lines.push({ label: line.label, amountCents });
  }
  for (const line of input.usage) {
    const amountCents = toCents(line.amountEur);
    if (amountCents !== 0) {
      lines.push({ label: line.label, quantity: line.quantity, amountCents });
    }
  }
  const netCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const taxCents = Math.round((netCents * input.taxPercent) / 100);
  return { lines, netCents, taxCents, grossCents: netCents + taxCents };
}

/** The amounts of the cancellation of an invoice: the same lines, negated. */
export function cancellationAmounts(original: InvoiceAmounts): InvoiceAmounts {
  return {
    lines: original.lines.map((line) => ({ ...line, amountCents: -line.amountCents })),
    netCents: -original.netCents,
    taxCents: -original.taxCents,
    grossCents: -original.grossCents,
  };
}

// --- dates ------------------------------------------------------------------------

/** The calendar day in Germany as YYYY-MM-DD (an invoice is dated where the seller sits). */
export function berlinDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** YYYY-MM-DD plus a number of days. */
export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

/** "2026-11-27" → "27.11.2026" */
export function formatDateDe(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

const MONTH_NAMES_DE = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

/** "2026-11" → "November 2026" */
export function invoicePeriodLabel(period: string): string {
  const [year, month] = period.split('-');
  return `${MONTH_NAMES_DE[Number(month) - 1] ?? month} ${year}`;
}

/** "2026-11" → "01.11.2026 – 30.11.2026" (the period of service on the invoice). */
export function invoiceServicePeriod(period: string): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return `01.${mm}.${year} – ${String(lastDay).padStart(2, '0')}.${mm}.${year}`;
}

/** 12345 → "123,45 €" */
export function formatCentsEur(cents: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

// --- an invoice as read from the database -------------------------------------------

export interface BillingInvoice {
  id: string;
  orgId: string | null;
  kind: InvoiceKind;
  number: string;
  period: string;
  issueDate: string;
  dueDate: string | null;
  seller: InvoiceSeller;
  recipient: InvoiceRecipient;
  lines: InvoiceLine[];
  taxMode: TaxMode;
  taxPercent: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
  cancelsInvoiceId: string | null;
  cancelledByInvoiceId: string | null;
  paymentStatus: InvoicePaymentStatus;
  paidAt: string | null;
  paidVia: 'manual' | 'stripe' | null;
  paidNote: string | null;
  pdfState: 'pending' | 'ready' | 'failed';
  pdfPath: string | null;
  mailState: 'none' | 'pending' | 'sent' | 'failed';
  mailTo: string | null;
  mailSentAt: string | null;
  mailError: string | null;
  createdAt: string;
}

export const BILLING_INVOICE_COLUMNS =
  'id, org_id, kind, number, period, issue_date, due_date, seller, recipient, lines, tax_mode, tax_percent, net_cents, tax_cents, gross_cents, cancels_invoice_id, cancelled_by_invoice_id, payment_status, paid_at, paid_via, paid_note, pdf_state, pdf_path, mail_state, mail_to, mail_sent_at, mail_error, created_at';

/** A row of billing_invoices; null when the frozen parts do not parse (never expected). */
export function parseInvoiceRow(row: Record<string, unknown> | null): BillingInvoice | null {
  if (!row) return null;
  const seller = invoiceSellerSchema.safeParse({ ...EMPTY_SELLER, ...(row.seller as object) });
  const recipient = invoiceRecipientSchema.safeParse(row.recipient);
  const lines = z.array(invoiceLineSchema).safeParse(row.lines);
  if (!seller.success || !recipient.success || !lines.success) return null;
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    id: String(row.id),
    orgId: text(row.org_id),
    kind: row.kind === 'cancellation' ? 'cancellation' : 'invoice',
    number: String(row.number),
    period: String(row.period),
    issueDate: String(row.issue_date),
    dueDate: text(row.due_date),
    seller: seller.data,
    recipient: recipient.data,
    lines: lines.data,
    taxMode: row.tax_mode === 'eu_reverse_charge' ? 'eu_reverse_charge' : 'de_vat',
    taxPercent: Number(row.tax_percent) || 0,
    netCents: Number(row.net_cents) || 0,
    taxCents: Number(row.tax_cents) || 0,
    grossCents: Number(row.gross_cents) || 0,
    cancelsInvoiceId: text(row.cancels_invoice_id),
    cancelledByInvoiceId: text(row.cancelled_by_invoice_id),
    paymentStatus:
      row.payment_status === 'paid' ? 'paid' : row.payment_status === 'void' ? 'void' : 'open',
    paidAt: text(row.paid_at),
    paidVia: row.paid_via === 'manual' || row.paid_via === 'stripe' ? row.paid_via : null,
    paidNote: text(row.paid_note),
    pdfState: row.pdf_state === 'ready' ? 'ready' : row.pdf_state === 'failed' ? 'failed' : 'pending',
    pdfPath: text(row.pdf_path),
    mailState:
      row.mail_state === 'pending' || row.mail_state === 'sent' || row.mail_state === 'failed'
        ? row.mail_state
        : 'none',
    mailTo: text(row.mail_to),
    mailSentAt: text(row.mail_sent_at),
    mailError: text(row.mail_error),
    createdAt: String(row.created_at),
  };
}

/** What a list shows as the state of an invoice. */
export type InvoiceDisplayStatus = 'paid' | 'open' | 'overdue' | 'cancelled' | 'cancellation';

export const INVOICE_DISPLAY_STATUS_LABELS: Record<InvoiceDisplayStatus, string> = {
  paid: 'Bezahlt',
  open: 'Offen',
  overdue: 'Überfällig',
  cancelled: 'Storniert',
  cancellation: 'Stornorechnung',
};

/** `today` as YYYY-MM-DD (berlinDate). */
export function invoiceDisplayStatus(
  invoice: Pick<BillingInvoice, 'kind' | 'paymentStatus' | 'dueDate' | 'cancelledByInvoiceId'>,
  today: string
): InvoiceDisplayStatus {
  if (invoice.kind === 'cancellation') return 'cancellation';
  if (invoice.cancelledByInvoiceId !== null || invoice.paymentStatus === 'void') return 'cancelled';
  if (invoice.paymentStatus === 'paid') return 'paid';
  return invoice.dueDate !== null && invoice.dueDate < today ? 'overdue' : 'open';
}

/** The storage path of an invoice's PDF inside the `invoices` bucket. */
export function invoicePdfPath(invoice: Pick<BillingInvoice, 'id' | 'number'>): string {
  // the id keeps the path unguessable and unique; the number makes it readable
  return `${invoice.id}/${invoice.number.replace(/[^A-Za-z0-9\-_.]/g, '_')}.pdf`;
}

/** The file name a downloaded or mailed PDF carries. */
export function invoiceFileName(invoice: Pick<BillingInvoice, 'kind' | 'number'>): string {
  const safe = invoice.number.replace(/[^A-Za-z0-9\-_.]/g, '_');
  return `${invoice.kind === 'cancellation' ? 'Stornorechnung' : 'Rechnung'}-${safe}.pdf`;
}
