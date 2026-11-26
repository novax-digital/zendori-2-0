// Billing details of an organization and the VAT rule for its invoices
// (Phase 15, docs/phase-15-stripe.md). Pure: no I/O, shared by web and worker.
//
// Owner decision: customers sit in Germany and the EU. German customers pay
// 19 % VAT; EU businesses with a confirmed VAT id are invoiced without VAT
// (reverse charge). Everything else is NOT invoiced automatically — the invoice
// is held and the operator decides. Zendori prices are net.
import { z } from 'zod';

/** The 27 EU member states (ISO 3166-1 alpha-2). */
export const EU_COUNTRIES = [
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
] as const;
export type EuCountry = (typeof EU_COUNTRIES)[number];

export const EU_COUNTRY_LABELS: Record<EuCountry, string> = {
  AT: 'Österreich',
  BE: 'Belgien',
  BG: 'Bulgarien',
  CY: 'Zypern',
  CZ: 'Tschechien',
  DE: 'Deutschland',
  DK: 'Dänemark',
  EE: 'Estland',
  ES: 'Spanien',
  FI: 'Finnland',
  FR: 'Frankreich',
  GR: 'Griechenland',
  HR: 'Kroatien',
  HU: 'Ungarn',
  IE: 'Irland',
  IT: 'Italien',
  LT: 'Litauen',
  LU: 'Luxemburg',
  LV: 'Lettland',
  MT: 'Malta',
  NL: 'Niederlande',
  PL: 'Polen',
  PT: 'Portugal',
  RO: 'Rumänien',
  SE: 'Schweden',
  SI: 'Slowenien',
  SK: 'Slowakei',
};

/** The seller's country: its customers pay domestic VAT. */
export const HOME_COUNTRY: EuCountry = 'DE';
/** German standard VAT rate in percent. */
export const DE_VAT_PERCENT = 19;

export function isEuCountry(value: unknown): value is EuCountry {
  return typeof value === 'string' && (EU_COUNTRIES as readonly string[]).includes(value);
}

/** Prefix of a country's VAT ids. Greece uses EL, everyone else the ISO code. */
export function vatPrefixForCountry(country: EuCountry): string {
  return country === 'GR' ? 'EL' : country;
}

/** Upper case without spaces, dots and dashes — the form VIES and Stripe expect. */
export function normalizeVatId(raw: string): string {
  return raw.toUpperCase().replace(/[\s.\-_/]/g, '');
}

// Two letters, then 2–12 characters (letters, digits; some countries use + or *).
const VAT_ID_PATTERN = /^[A-Z]{2}[A-Z0-9+*]{2,12}$/;

export function isVatIdFormat(value: string): boolean {
  return VAT_ID_PATTERN.test(value);
}

export const billingDetailsSchema = z
  .object({
    legalName: z.string().trim().min(2).max(150),
    addressLine1: z.string().trim().min(2).max(200),
    addressLine2: z.string().trim().max(200),
    postalCode: z.string().trim().min(2).max(20),
    city: z.string().trim().min(1).max(100),
    country: z.enum(EU_COUNTRIES),
    /** Normalized; empty = none. */
    vatId: z.string().max(40).transform(normalizeVatId),
    billingEmail: z.email().max(254),
  })
  .superRefine((value, ctx) => {
    if (value.vatId === '') {
      if (value.country !== HOME_COUNTRY) {
        ctx.addIssue({ code: 'custom', path: ['vatId'], message: 'vat_id_required' });
      }
      return;
    }
    if (!isVatIdFormat(value.vatId)) {
      ctx.addIssue({ code: 'custom', path: ['vatId'], message: 'vat_id_format' });
      return;
    }
    if (!value.vatId.startsWith(vatPrefixForCountry(value.country))) {
      ctx.addIssue({ code: 'custom', path: ['vatId'], message: 'vat_id_country' });
    }
  });
export type BillingDetails = z.infer<typeof billingDetailsSchema>;

/** German messages for the form (keyed by the first failing field). */
export const BILLING_DETAILS_ERRORS: Record<string, string> = {
  legalName: 'Bitte gib den Firmennamen an.',
  addressLine1: 'Bitte gib Straße und Hausnummer an.',
  addressLine2: 'Der Adresszusatz ist zu lang.',
  postalCode: 'Bitte gib die Postleitzahl an.',
  city: 'Bitte gib den Ort an.',
  country: 'Bitte wähle ein Land aus der Liste.',
  billingEmail: 'Bitte gib eine gültige Rechnungs-E-Mail an.',
  vat_id_required: 'Für Kunden außerhalb Deutschlands ist die USt-ID erforderlich.',
  vat_id_format: 'Die USt-ID hat kein gültiges Format (zum Beispiel DE123456789).',
  vat_id_country: 'Die USt-ID passt nicht zum gewählten Land.',
};

export function billingDetailsErrorMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Die Rechnungsdaten sind unvollständig.';
  const field = typeof issue.path[0] === 'string' ? issue.path[0] : '';
  if (field === 'vatId') {
    return BILLING_DETAILS_ERRORS[issue.message] ?? BILLING_DETAILS_ERRORS.vat_id_format ?? '';
  }
  return BILLING_DETAILS_ERRORS[field] ?? 'Die Rechnungsdaten sind unvollständig.';
}

/** A billing_accounts row as stored (every column nullable until filled in). */
export interface BillingAccountRow {
  legal_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  postal_code: string | null;
  city: string | null;
  country: string | null;
  vat_id: string | null;
  billing_email: string | null;
}

/** The stored details if they are complete and valid, else null. */
export function parseBillingAccountRow(row: BillingAccountRow | null): BillingDetails | null {
  if (!row) return null;
  const parsed = billingDetailsSchema.safeParse({
    legalName: row.legal_name ?? '',
    addressLine1: row.address_line1 ?? '',
    addressLine2: row.address_line2 ?? '',
    postalCode: row.postal_code ?? '',
    city: row.city ?? '',
    country: row.country ?? '',
    vatId: row.vat_id ?? '',
    billingEmail: row.billing_email ?? '',
  });
  return parsed.success ? parsed.data : null;
}

export function billingDetailsToRow(details: BillingDetails): BillingAccountRow {
  return {
    legal_name: details.legalName,
    address_line1: details.addressLine1,
    address_line2: details.addressLine2 === '' ? null : details.addressLine2,
    postal_code: details.postalCode,
    city: details.city,
    country: details.country,
    vat_id: details.vatId === '' ? null : details.vatId,
    billing_email: details.billingEmail,
  };
}

// --- VAT id check ------------------------------------------------------------

/** Result of the VIES check Stripe runs for an EU VAT id. */
export const VAT_ID_STATUSES = ['pending', 'verified', 'unverified', 'unavailable'] as const;
export type VatIdStatus = (typeof VAT_ID_STATUSES)[number];

export function isVatIdStatus(value: unknown): value is VatIdStatus {
  return typeof value === 'string' && (VAT_ID_STATUSES as readonly string[]).includes(value);
}

export const VAT_ID_STATUS_LABELS: Record<VatIdStatus, string> = {
  pending: 'Prüfung läuft',
  verified: 'Bestätigt',
  unverified: 'Nicht bestätigt',
  unavailable: 'Prüfung nicht möglich',
};

/** What is known about the check of ONE VAT id value. */
export interface VatIdCheck {
  /** The VAT id the status and the confirmation belong to. */
  value: string | null;
  status: VatIdStatus | null;
  /** The operator confirmed this VAT id by hand. */
  confirmed: boolean;
}

/** Does the check cover the VAT id that is on file now, with a positive result? */
export function isVatIdAccepted(vatId: string, check: VatIdCheck | null): boolean {
  if (!check || vatId === '' || check.value !== vatId) return false;
  return check.confirmed || check.status === 'verified';
}

// --- tax decision ------------------------------------------------------------

export type TaxMode = 'de_vat' | 'eu_reverse_charge';
/** Stripe's customer.tax_exempt value that goes with a decision. */
export type TaxExempt = 'none' | 'reverse';

export const TAX_HOLD_REASONS = ['missing_details', 'vat_id_unverified'] as const;
export type TaxHoldReason = (typeof TAX_HOLD_REASONS)[number];

export const TAX_HOLD_REASON_LABELS: Record<TaxHoldReason, string> = {
  missing_details: 'Rechnungsdaten fehlen oder sind unvollständig',
  vat_id_unverified: 'USt-ID ist nicht bestätigt',
};

export type TaxDecision =
  | { kind: 'charge'; mode: TaxMode; percent: number; taxExempt: TaxExempt }
  | { kind: 'hold'; reason: TaxHoldReason };

/**
 * How an invoice for this customer is taxed — or why it must not go out.
 *  · Germany: 19 % VAT, whatever the state of the VAT id (it is only printed).
 *  · other EU country: reverse charge, but only with an accepted VAT id. An EU
 *    customer is never silently billed with German VAT or without any.
 * Details that do not parse (missing fields, a country outside the EU) hold.
 */
export function decideTax(details: BillingDetails | null, check: VatIdCheck | null): TaxDecision {
  if (!details) return { kind: 'hold', reason: 'missing_details' };
  if (details.country === HOME_COUNTRY) {
    return { kind: 'charge', mode: 'de_vat', percent: DE_VAT_PERCENT, taxExempt: 'none' };
  }
  if (!isVatIdAccepted(details.vatId, check)) {
    return { kind: 'hold', reason: 'vat_id_unverified' };
  }
  return { kind: 'charge', mode: 'eu_reverse_charge', percent: 0, taxExempt: 'reverse' };
}

/**
 * The tax_exempt value kept on the Stripe customer between invoices: reverse for
 * an EU business outside Germany, none otherwise. The invoice run decides again
 * with decideTax and writes its own value right before it creates the invoice.
 */
export function customerTaxExempt(details: BillingDetails): TaxExempt {
  return details.country !== HOME_COUNTRY && details.vatId !== '' ? 'reverse' : 'none';
}

// --- payment method ----------------------------------------------------------

export const PAYMENT_METHOD_TYPES = ['card', 'sepa_debit'] as const;
export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number];

export function isPaymentMethodType(value: unknown): value is PaymentMethodType {
  return typeof value === 'string' && (PAYMENT_METHOD_TYPES as readonly string[]).includes(value);
}

const CARD_BRAND_LABELS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  girocard: 'girocard',
  cartes_bancaires: 'Cartes Bancaires',
  diners: 'Diners Club',
  discover: 'Discover',
  jcb: 'JCB',
  unionpay: 'UnionPay',
};

/** What the customer sees: kind and the last four digits, never more. */
export function paymentMethodLabel(
  type: PaymentMethodType,
  info: { brand?: string | null; last4?: string | null }
): string {
  const tail = info.last4 && /^\d{4}$/.test(info.last4) ? ` •••• ${info.last4}` : '';
  if (type === 'sepa_debit') return `SEPA-Lastschrift${tail}`;
  const brand = info.brand ? (CARD_BRAND_LABELS[info.brand] ?? 'Karte') : 'Karte';
  return `${brand}${tail}`;
}

// --- billing period key ------------------------------------------------------

const PERIOD_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `YYYY-MM` of a UTC calendar month — the key invoices and "ab Monat" use. */
export function isPeriodKey(value: unknown): value is string {
  return typeof value === 'string' && PERIOD_KEY_PATTERN.test(value);
}

export function periodKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The period `offset` months after (negative: before) the given one. */
export function shiftPeriodKey(key: string, offset: number): string {
  const [year, month] = key.split('-').map(Number) as [number, number];
  return periodKeyOf(new Date(Date.UTC(year, month - 1 + offset, 1)));
}
