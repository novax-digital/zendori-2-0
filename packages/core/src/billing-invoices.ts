import {
  addDays,
  berlinDate,
  BILLING_INVOICE_COLLECT_COLUMNS,
  BILLING_INVOICE_COLUMNS,
  type BillingInvoice,
  type BillingSellerRow,
  buildInvoiceAmounts,
  cancellationAmounts,
  invoiceFileName,
  invoicePeriodLabel,
  parseInvoiceRow,
  sellerFromRow,
  sellerMissingFields,
  type SellerSettings,
  sellerToRow,
} from './billing-invoice.js';
import {
  type BillingAccountRow,
  type BillingDetails,
  decideTax,
  HOME_COUNTRY,
  isPeriodKey,
  isVatIdAccepted,
  parseBillingAccountRow,
  periodKeyOf,
  TAX_HOLD_REASON_LABELS,
} from './billing-tax.js';
import {
  isMissingColumnError,
  isMissingRelationError,
  type SupabaseClient,
} from './db.js';
import {
  formatQuantity,
  getOrgInvoice,
  loadBillingCatalog,
  monthPeriod,
} from './billing-statement.js';

// Own invoices (Phase 15b, migration 0046), reading and writing: the seller's details,
// issuing an invoice for a customer and a month, cancelling, payment state and
// the PDF link. Service role only — every caller has done its own access check
// (platform admin, the membership of the customer who looks at their own, or
// the worker's monthly run). Lives in core so the app and the worker issue an
// invoice with the same code.
//
// The app decides WHAT is on an invoice and stores it frozen, in one
// transaction with its number (issue_billing_invoice). The worker then renders
// the PDF and sends the mail; it cannot change the content.

export const INVOICE_BUCKET = 'invoices';

// --- the seller -----------------------------------------------------------------

export interface SellerState {
  /** false = migration 0046 is not applied yet. */
  available: boolean;
  settings: SellerSettings;
  /** What still has to be filled in before an invoice can be issued; empty = ready. */
  missing: string[];
}

export async function loadSellerState(admin: SupabaseClient): Promise<SellerState> {
  const { data, error } = await admin.from('billing_seller').select('*').maybeSingle();
  if (error) {
    const settings = sellerFromRow(null);
    return {
      available: !isMissingRelationError(error),
      settings,
      missing: sellerMissingFields(settings.seller),
    };
  }
  const settings = sellerFromRow((data as BillingSellerRow | null) ?? null);
  return { available: true, settings, missing: sellerMissingFields(settings.seller) };
}

export async function saveSellerSettings(
  admin: SupabaseClient,
  settings: SellerSettings,
  userId: string
): Promise<{ error: boolean; autoRunUnavailable: boolean }> {
  const row = {
    id: true,
    ...sellerToRow(settings),
    updated_at: new Date().toISOString(),
    updated_by: userId,
  };
  let { error } = await admin.from('billing_seller').upsert(row, { onConflict: 'id' });
  let autoRunUnavailable = false;
  if (error && isMissingColumnError(error)) {
    // 0048 not applied yet: the days until a charge are not stored (the default applies)
    const { collect_after_days: _days, ...without0048 } = row;
    ({ error } = await admin.from('billing_seller').upsert(without0048, { onConflict: 'id' }));
    if (error && isMissingColumnError(error)) {
      // 0047 not applied yet either: everything but the start month of the run is saved
      autoRunUnavailable = settings.autoInvoiceFrom !== null;
      const { auto_invoice_from: _from, ...without0047 } = without0048;
      ({ error } = await admin.from('billing_seller').upsert(without0047, { onConflict: 'id' }));
    }
  }
  return { error: Boolean(error), autoRunUnavailable };
}

// --- reading invoices -------------------------------------------------------------

export interface InvoiceList {
  /** false = migration 0046 is not applied yet. */
  available: boolean;
  invoices: BillingInvoice[];
}

/**
 * The invoice columns with those of 0048 (how it is paid, the charge) — or, as
 * long as that migration is missing, without them: an invoice then reads as a
 * transfer invoice without a charge.
 */
export const INVOICE_COLUMN_SETS: readonly string[] = [
  `${BILLING_INVOICE_COLUMNS}, ${BILLING_INVOICE_COLLECT_COLUMNS}`,
  BILLING_INVOICE_COLUMNS,
];

export async function listInvoices(
  admin: SupabaseClient,
  filter: { orgId?: string; limit?: number } = {}
): Promise<InvoiceList> {
  let data: unknown = null;
  let error: unknown = null;
  for (const columns of INVOICE_COLUMN_SETS) {
    let query = admin
      .from('billing_invoices')
      .select(columns)
      .order('created_at', { ascending: false })
      .limit(filter.limit ?? 500);
    if (filter.orgId) query = query.eq('org_id', filter.orgId);
    ({ data, error } = await query);
    if (!(error && isMissingColumnError(error))) break;
  }
  if (error) return { available: !isMissingRelationError(error), invoices: [] };
  const invoices = ((data ?? []) as unknown as Record<string, unknown>[])
    .map(parseInvoiceRow)
    .filter((invoice): invoice is BillingInvoice => invoice !== null);
  return { available: true, invoices };
}

export async function loadInvoice(
  admin: SupabaseClient,
  invoiceId: string
): Promise<BillingInvoice | null> {
  let data: unknown = null;
  let error: unknown = null;
  for (const columns of INVOICE_COLUMN_SETS) {
    ({ data, error } = await admin
      .from('billing_invoices')
      .select(columns)
      .eq('id', invoiceId)
      .maybeSingle());
    if (!(error && isMissingColumnError(error))) break;
  }
  if (error) return null;
  return parseInvoiceRow((data as unknown as Record<string, unknown> | null) ?? null);
}

/** A link to the PDF that works for one minute; null while the PDF is not there yet. */
export async function invoicePdfUrl(
  admin: SupabaseClient,
  invoice: BillingInvoice
): Promise<string | null> {
  if (invoice.pdfState !== 'ready' || !invoice.pdfPath) return null;
  const { data, error } = await admin.storage
    .from(INVOICE_BUCKET)
    .createSignedUrl(invoice.pdfPath, 60, { download: invoiceFileName(invoice) });
  return error || !data ? null : data.signedUrl;
}

// --- the customer's billing details and VAT id ---------------------------------------

const ACCOUNT_COLUMNS =
  'legal_name, address_line1, address_line2, postal_code, city, country, vat_id, billing_email';

interface AccountRow extends BillingAccountRow {
  vat_id_confirmed_value?: string | null;
}

/** Who an invoice goes to, as it is on file now. */
export interface BillingRecipientState {
  /** What is stored, complete or not (to prefill the form). */
  stored: BillingAccountRow | null;
  /** Complete and valid details, else null — without them no invoice. */
  details: BillingDetails | null;
  /** An EU customer outside Germany needs a confirmed VAT id (reverse charge). */
  needsVatConfirmation: boolean;
}

/** Reads a customer's billing details for the invoice pages — works without Stripe. */
export async function loadBillingRecipient(
  admin: SupabaseClient,
  orgId: string
): Promise<BillingRecipientState> {
  let { data, error } = await admin
    .from('billing_accounts')
    .select(`${ACCOUNT_COLUMNS}, vat_id_confirmed_value`)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await admin
      .from('billing_accounts')
      .select(ACCOUNT_COLUMNS)
      .eq('org_id', orgId)
      .maybeSingle());
  }
  const stored = error ? null : ((data as AccountRow | null) ?? null);
  const details = parseBillingAccountRow(stored);
  return {
    stored,
    details,
    needsVatConfirmation:
      details !== null &&
      details.country !== HOME_COUNTRY &&
      (stored as AccountRow | null)?.vat_id_confirmed_value !== details.vatId,
  };
}

/**
 * The operator vouches for the VAT id that is on file now (independent of
 * Stripe). Stored with the value it was given for — a changed VAT id needs a
 * new confirmation.
 */
export async function confirmAccountVatId(
  admin: SupabaseClient,
  orgId: string,
  userId: string
): Promise<{ error: string | null }> {
  const { data } = await admin
    .from('billing_accounts')
    .select(ACCOUNT_COLUMNS)
    .eq('org_id', orgId)
    .maybeSingle();
  const details = parseBillingAccountRow((data as BillingAccountRow | null) ?? null);
  if (!details || details.vatId === '') {
    return { error: 'Für diesen Kunden ist keine USt-ID hinterlegt.' };
  }
  const { error } = await admin
    .from('billing_accounts')
    .update({
      vat_id_confirmed_value: details.vatId,
      vat_id_confirmed_at: new Date().toISOString(),
      vat_id_confirmed_by: userId,
    })
    .eq('org_id', orgId);
  if (error) {
    return {
      error: isMissingColumnError(error)
        ? 'Das Bestätigen ist noch nicht verfügbar (Migration 0046 ausstehend).'
        : 'Die USt-ID konnte nicht bestätigt werden.',
    };
  }
  return { error: null };
}

// --- issuing ----------------------------------------------------------------------

/**
 * Why an invoice was not issued — a word for the monthly run to store, next to
 * the sentence for a person.
 */
export const ISSUE_FAILURE_REASONS = [
  'not_finished',
  'unavailable',
  'seller_incomplete',
  'missing_details',
  'vat_id_unverified',
  'already_invoiced',
  'nothing_to_charge',
  'error',
] as const;
export type IssueFailureReason = (typeof ISSUE_FAILURE_REASONS)[number];

/** Why the monthly run did not issue an invoice, in words for the operator. */
export const ISSUE_FAILURE_LABELS: Record<IssueFailureReason, string> = {
  not_finished: 'Monat noch nicht abgeschlossen',
  unavailable: 'Rechnungen nicht verfügbar',
  seller_incomplete: 'Rechnungssteller unvollständig',
  missing_details: 'Rechnungsdaten fehlen oder sind unvollständig',
  vat_id_unverified: 'USt-ID ist nicht bestätigt',
  already_invoiced: 'schon von Hand berechnet',
  nothing_to_charge: 'nichts zu berechnen',
  error: 'Fehler beim Erstellen',
};

/** Reasons the run does not come back to: waiting changes nothing. */
export const ISSUE_FINAL_REASONS: readonly IssueFailureReason[] = [
  'nothing_to_charge',
  'already_invoiced',
];

export interface InvoiceRunSkip {
  orgId: string;
  period: string;
  reason: IssueFailureReason;
  updatedAt: string;
}

/**
 * Customers the monthly run could not invoice and will try again (0047) — the
 * operator's to-do list. Empty before the migration.
 */
export async function listInvoiceRunSkips(admin: SupabaseClient): Promise<InvoiceRunSkip[]> {
  const { data, error } = await admin
    .from('billing_invoice_runs')
    .select('org_id, period, reason, updated_at')
    .eq('outcome', 'skipped')
    .order('period', { ascending: false })
    .limit(200);
  if (error) return [];
  return ((data ?? []) as { org_id: string; period: string; reason: string; updated_at: string }[])
    .filter(
      (row) =>
        (ISSUE_FAILURE_REASONS as readonly string[]).includes(row.reason) &&
        !ISSUE_FINAL_REASONS.includes(row.reason as IssueFailureReason)
    )
    .map((row) => ({
      orgId: row.org_id,
      period: row.period,
      reason: row.reason as IssueFailureReason,
      updatedAt: row.updated_at,
    }));
}

export type IssueResult =
  | { ok: true; invoice: BillingInvoice }
  | { ok: false; reason: IssueFailureReason; error: string };

function issueArgs(input: {
  orgId: string | null;
  kind: 'invoice' | 'cancellation';
  period: string;
  issueDate: string;
  dueDate: string | null;
  seller: unknown;
  recipient: unknown;
  lines: unknown;
  taxMode: string;
  taxPercent: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
  mailTo: string;
  cancelsInvoiceId: string | null;
  userId: string | null;
}): Record<string, unknown> {
  return {
    p_org_id: input.orgId,
    p_kind: input.kind,
    p_period: input.period,
    p_issue_date: input.issueDate,
    p_due_date: input.dueDate,
    p_seller: input.seller,
    p_recipient: input.recipient,
    p_lines: input.lines,
    p_tax_mode: input.taxMode,
    p_tax_percent: input.taxPercent,
    p_net_cents: input.netCents,
    p_tax_cents: input.taxCents,
    p_gross_cents: input.grossCents,
    p_mail_to: input.mailTo,
    p_cancels_invoice_id: input.cancelsInvoiceId,
    p_created_by: input.userId,
  };
}

/** The smallest amount Stripe charges in EUR (cents). Below it the invoice asks for a transfer. */
export const MIN_COLLECT_CENTS = 50;

export interface InvoiceCollection {
  type: 'sepa_debit' | 'card';
  /** "SEPA-Lastschrift •••• 3000" — what the invoice prints. */
  label: string;
  livemode: boolean;
}

/**
 * Is this invoice collected through Stripe? Yes when — in the caller's Stripe
 * mode — the operator switched the customer to Stripe billing, the month is
 * not before the first month to be billed that way, and a payment method is
 * on file. Otherwise (also before migration 0048) the invoice asks for a
 * transfer; nothing about Stripe can keep an invoice from being issued.
 */
export async function decideCollection(
  admin: SupabaseClient,
  input: { orgId: string; period: string; stripeLivemode: boolean | null; grossCents: number }
): Promise<InvoiceCollection | null> {
  if (input.stripeLivemode === null || input.grossCents < MIN_COLLECT_CENTS) return null;
  // without 0048 the invoice could not carry the charge
  const probe = await admin.from('billing_invoices').select('collect_state').limit(1);
  if (probe.error) return null;
  const { data, error } = await admin
    .from('billing_stripe_customers')
    .select(
      'enabled, invoice_from, stripe_customer_id, payment_method_id, payment_method_type, payment_method_label'
    )
    .eq('org_id', input.orgId)
    .eq('livemode', input.stripeLivemode)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    enabled: boolean;
    invoice_from: string | null;
    stripe_customer_id: string | null;
    payment_method_id: string | null;
    payment_method_type: string | null;
    payment_method_label: string | null;
  };
  if (!row.enabled || !row.stripe_customer_id || !row.payment_method_id) return null;
  if (isPeriodKey(row.invoice_from) && input.period < row.invoice_from) return null;
  if (row.payment_method_type !== 'sepa_debit' && row.payment_method_type !== 'card') return null;
  return {
    type: row.payment_method_type,
    label:
      row.payment_method_label ??
      (row.payment_method_type === 'sepa_debit' ? 'SEPA-Lastschrift' : 'Karte'),
    livemode: input.stripeLivemode,
  };
}

/**
 * Issues the invoice of one customer for one month: calculates the month as
 * the billing pages show it, freezes lines and amounts, and stores it with the
 * next number. The worker then renders the PDF and mails it to the billing
 * address. Refuses — with a sentence the operator can act on — when something
 * a correct invoice needs is missing.
 */
export async function issueInvoiceForMonth(
  admin: SupabaseClient,
  /**
   * `userId` null = issued by the monthly run. `stripeLivemode` = the Stripe
   * mode of the caller (null/absent = Stripe is not configured): a customer who
   * is billed through Stripe in that mode gets an invoice that is collected.
   */
  input: {
    orgId: string;
    period: string;
    userId: string | null;
    now?: Date;
    stripeLivemode?: boolean | null;
  }
): Promise<IssueResult> {
  const now = input.now ?? new Date();
  if (!isPeriodKey(input.period)) {
    return { ok: false, reason: 'error', error: 'Bitte einen Monat wählen.' };
  }
  // only a month that is over: the running month is not complete yet
  if (input.period >= periodKeyOf(now)) {
    return {
      ok: false,
      reason: 'not_finished',
      error: `${invoicePeriodLabel(input.period)} ist noch nicht abgeschlossen. Eine Rechnung gibt es erst für einen vergangenen Monat.`,
    };
  }

  const sellerState = await loadSellerState(admin);
  if (!sellerState.available) {
    return {
      ok: false,
      reason: 'unavailable',
      error: 'Rechnungen sind noch nicht verfügbar (Migration 0046 ausstehend).',
    };
  }
  if (sellerState.missing.length > 0) {
    return {
      ok: false,
      reason: 'seller_incomplete',
      error: `Beim Rechnungssteller fehlt noch: ${sellerState.missing.join(', ')}.`,
    };
  }

  const { data: accountData, error: accountError } = await admin
    .from('billing_accounts')
    .select(`${ACCOUNT_COLUMNS}, vat_id_confirmed_value`)
    .eq('org_id', input.orgId)
    .maybeSingle();
  if (accountError) {
    return { ok: false, reason: 'error', error: 'Die Rechnungsdaten konnten nicht gelesen werden.' };
  }
  const account = (accountData as AccountRow | null) ?? null;
  const details = parseBillingAccountRow(account);

  // The VAT id counts as accepted when the operator confirmed exactly this value
  // here, or Stripe's check (or the confirmation there) covers it.
  let accepted = details !== null && details.vatId !== '' && account?.vat_id_confirmed_value === details.vatId;
  if (details && details.vatId !== '' && !accepted) {
    const { data: stripeRows } = await admin
      .from('billing_stripe_customers')
      .select('vat_id_value, vat_id_status, vat_id_confirmed_value')
      .eq('org_id', input.orgId);
    for (const row of (stripeRows ?? []) as {
      vat_id_value: string | null;
      vat_id_status: string | null;
      vat_id_confirmed_value: string | null;
    }[]) {
      if (
        row.vat_id_confirmed_value === details.vatId ||
        isVatIdAccepted(details.vatId, {
          value: row.vat_id_value,
          status: row.vat_id_status === 'verified' ? 'verified' : null,
          confirmed: false,
        })
      ) {
        accepted = true;
      }
    }
  }
  const tax = decideTax(
    details,
    details ? { value: details.vatId, status: null, confirmed: accepted } : null
  );
  if (tax.kind === 'hold' || !details) {
    return {
      ok: false,
      reason: tax.kind === 'hold' ? tax.reason : 'missing_details',
      error: `Rechnung nicht möglich: ${tax.kind === 'hold' ? TAX_HOLD_REASON_LABELS[tax.reason] : 'Rechnungsdaten fehlen'}.`,
    };
  }

  const { data: existing } = await admin
    .from('billing_invoices')
    .select('number')
    .eq('org_id', input.orgId)
    .eq('period', input.period)
    .eq('kind', 'invoice')
    .is('cancelled_by_invoice_id', null)
    .maybeSingle();
  if (existing) {
    return {
      ok: false,
      reason: 'already_invoiced',
      error: `Für ${invoicePeriodLabel(input.period)} gibt es schon die Rechnung ${(existing as { number: string }).number}. Storniere sie zuerst, wenn sie ersetzt werden soll.`,
    };
  }

  const [year, month] = input.period.split('-').map(Number) as [number, number];
  const catalog = await loadBillingCatalog(admin);
  const computed = await getOrgInvoice(admin, input.orgId, monthPeriod(year, month), catalog);
  const amounts = buildInvoiceAmounts({
    fixed: computed.recurring.map((line) => ({ label: line.label, amountEur: line.amountEur })),
    usage: computed.usage.lines.map((line) => ({
      label: line.label,
      quantity: formatQuantity(line.quantity, line.unit),
      amountEur: line.priceEur,
    })),
    taxPercent: tax.percent,
  });
  if (amounts.grossCents <= 0) {
    return {
      ok: false,
      reason: 'nothing_to_charge',
      error: `Für ${invoicePeriodLabel(input.period)} ist nichts zu berechnen.`,
    };
  }

  const issueDate = berlinDate(now);
  const collection = await decideCollection(admin, {
    orgId: input.orgId,
    period: input.period,
    stripeLivemode: input.stripeLivemode ?? null,
    grossCents: amounts.grossCents,
  });
  const collectOn = collection
    ? addDays(issueDate, sellerState.settings.collectAfterDays)
    : null;
  const base = issueArgs({
    orgId: input.orgId,
    kind: 'invoice',
    period: input.period,
    issueDate,
    // a collected invoice is due on the day it is collected
    dueDate: collectOn ?? addDays(issueDate, sellerState.settings.paymentTermDays),
    seller: sellerState.settings.seller,
    recipient: details,
    lines: amounts.lines,
    taxMode: tax.mode,
    taxPercent: tax.percent,
    netCents: amounts.netCents,
    taxCents: amounts.taxCents,
    grossCents: amounts.grossCents,
    mailTo: details.billingEmail,
    cancelsInvoiceId: null,
    userId: input.userId,
  });
  // The 16-argument form issues a transfer invoice (and exists before 0048);
  // the charge needs the four arguments of 0048.
  const { data, error } = await admin.rpc(
    'issue_billing_invoice',
    collection && collectOn
      ? {
          ...base,
          p_payment_method: collection.type,
          p_payment_label: collection.label,
          p_collect_on: collectOn,
          p_collect_livemode: collection.livemode,
        }
      : base
  );
  const invoice = parseInvoiceRow((data as Record<string, unknown> | null) ?? null);
  if (error || !invoice) {
    const duplicate = (error as { code?: string } | null)?.code === '23505';
    return {
      ok: false,
      reason: duplicate ? 'already_invoiced' : 'error',
      error: duplicate
        ? `Für ${invoicePeriodLabel(input.period)} gibt es schon eine Rechnung.`
        : 'Die Rechnung konnte nicht erstellt werden.',
    };
  }
  return { ok: true, invoice };
}

/**
 * Cancels an invoice: issues a cancellation document (own number, the same
 * lines negated) that refers to it. The original stays as it is and is marked
 * cancelled; afterwards a new invoice for the month can be issued.
 */
export async function cancelInvoice(
  admin: SupabaseClient,
  input: { invoiceId: string; userId: string; now?: Date }
): Promise<IssueResult> {
  const original = await loadInvoice(admin, input.invoiceId);
  if (!original || original.kind !== 'invoice') {
    return { ok: false, reason: 'error', error: 'Die Rechnung wurde nicht gefunden.' };
  }
  if (original.cancelledByInvoiceId) {
    return { ok: false, reason: 'error', error: 'Diese Rechnung ist bereits storniert.' };
  }
  const sellerState = await loadSellerState(admin);
  if (sellerState.missing.length > 0) {
    return {
      ok: false,
      reason: 'seller_incomplete',
      error: `Beim Rechnungssteller fehlt noch: ${sellerState.missing.join(', ')}.`,
    };
  }
  const amounts = cancellationAmounts({
    lines: original.lines,
    netCents: original.netCents,
    taxCents: original.taxCents,
    grossCents: original.grossCents,
  });
  const { data, error } = await admin.rpc(
    'issue_billing_invoice',
    issueArgs({
      orgId: original.orgId,
      kind: 'cancellation',
      period: original.period,
      issueDate: berlinDate(input.now ?? new Date()),
      dueDate: null,
      // a new document of today: today's seller, the recipient as invoiced
      seller: sellerState.settings.seller,
      recipient: original.recipient,
      lines: amounts.lines,
      taxMode: original.taxMode,
      taxPercent: original.taxPercent,
      netCents: amounts.netCents,
      taxCents: amounts.taxCents,
      grossCents: amounts.grossCents,
      mailTo: original.mailTo ?? original.recipient.billingEmail,
      cancelsInvoiceId: original.id,
      userId: input.userId,
    })
  );
  const invoice = parseInvoiceRow((data as Record<string, unknown> | null) ?? null);
  if (error || !invoice) {
    return { ok: false, reason: 'error', error: 'Die Rechnung konnte nicht storniert werden.' };
  }
  return { ok: true, invoice };
}

// --- payment and mail ---------------------------------------------------------------

/** Marks an open invoice as paid by hand, or a paid one as open again. */
export async function setInvoicePaid(
  admin: SupabaseClient,
  input: { invoiceId: string; paid: boolean; note: string; userId: string }
): Promise<{ error: string | null }> {
  const invoice = await loadInvoice(admin, input.invoiceId);
  if (!invoice || invoice.kind !== 'invoice' || invoice.paymentStatus === 'void') {
    return { error: 'Diese Rechnung kann nicht als bezahlt markiert werden.' };
  }
  const { error } = await admin
    .from('billing_invoices')
    .update(
      input.paid
        ? {
            payment_status: 'paid',
            paid_at: new Date().toISOString(),
            paid_via: 'manual',
            paid_note: input.note === '' ? null : input.note.slice(0, 300),
            paid_by: input.userId,
          }
        : { payment_status: 'open', paid_at: null, paid_via: null, paid_note: null, paid_by: null }
    )
    .eq('id', invoice.id)
    // never touch a cancelled invoice, whatever happened in between
    .neq('payment_status', 'void');
  if (error) return { error: 'Der Zahlstatus konnte nicht gespeichert werden.' };
  if (input.paid && (invoice.collectState === 'scheduled' || invoice.collectState === 'failed')) {
    // Paid by hand: the charge must not happen on top of it. One that is
    // already under way at Stripe cannot be taken back here and stays visible.
    const { error: stopError } = await admin
      .from('billing_invoices')
      .update({ collect_state: 'none', collect_next_attempt_at: null })
      .eq('id', invoice.id)
      .in('collect_state', ['scheduled', 'failed']);
    if (stopError) {
      return {
        error:
          'Als bezahlt markiert, aber der geplante Einzug konnte nicht gestoppt werden. Bitte erneut versuchen.',
      };
    }
  }
  return { error: null };
}

/**
 * Asks the worker to charge an invoice again after a failed charge. A new
 * attempt uses a new idempotency key at Stripe; the date printed on the invoice
 * stays as it is.
 */
export async function requestInvoiceCollection(
  admin: SupabaseClient,
  invoiceId: string
): Promise<{ error: string | null }> {
  const invoice = await loadInvoice(admin, invoiceId);
  if (
    !invoice ||
    invoice.kind !== 'invoice' ||
    invoice.paymentStatus !== 'open' ||
    invoice.paymentMethod === 'transfer' ||
    invoice.collectState !== 'failed'
  ) {
    return { error: 'Für diese Rechnung kann kein Einzug angestoßen werden.' };
  }
  const { data: row } = await admin
    .from('billing_invoices')
    .select('collect_attempts')
    .eq('id', invoice.id)
    .maybeSingle();
  const attempts = Number((row as { collect_attempts: number } | null)?.collect_attempts) || 0;
  const { error } = await admin
    .from('billing_invoices')
    .update({
      collect_state: 'scheduled',
      collect_attempts: attempts + 1,
      collect_error: null,
      collect_next_attempt_at: null,
      stripe_payment_intent_id: null,
    })
    .eq('id', invoice.id)
    .eq('collect_state', 'failed');
  return { error: error ? 'Der Einzug konnte nicht vorgemerkt werden.' : null };
}

/**
 * Asks the worker to send the invoice (again) — to the billing address that is
 * on file NOW, falling back to where it went before. Also restarts a PDF that
 * failed for good.
 */
export async function requestInvoiceMail(
  admin: SupabaseClient,
  invoiceId: string
): Promise<{ error: string | null }> {
  const invoice = await loadInvoice(admin, invoiceId);
  if (!invoice) return { error: 'Die Rechnung wurde nicht gefunden.' };
  let mailTo = invoice.mailTo ?? invoice.recipient.billingEmail;
  if (invoice.orgId) {
    const { data } = await admin
      .from('billing_accounts')
      .select('billing_email')
      .eq('org_id', invoice.orgId)
      .maybeSingle();
    const current = (data as { billing_email: string | null } | null)?.billing_email?.trim();
    if (current) mailTo = current;
  }
  if (!mailTo) return { error: 'Für diesen Kunden ist keine Rechnungs-E-Mail hinterlegt.' };
  const { error } = await admin
    .from('billing_invoices')
    .update({
      mail_state: 'pending',
      mail_to: mailTo,
      mail_attempts: 0,
      mail_error: null,
      next_attempt_at: null,
      ...(invoice.pdfState === 'failed'
        ? { pdf_state: 'pending', pdf_attempts: 0, pdf_error: null }
        : {}),
    })
    .eq('id', invoice.id);
  return { error: error ? 'Der Versand konnte nicht vorgemerkt werden.' : null };
}

/** Months an invoice can be created for: the last twelve that are over. */
export function invoiceableMonths(now: Date): { key: string; label: string }[] {
  const current = periodKeyOf(now);
  const out: { key: string; label: string }[] = [];
  let [year, month] = current.split('-').map(Number) as [number, number];
  for (let i = 0; i < 12; i += 1) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    const key = `${year}-${String(month).padStart(2, '0')}`;
    out.push({ key, label: invoicePeriodLabel(key) });
  }
  return out;
}
