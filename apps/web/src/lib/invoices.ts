import 'server-only';
import {
  BILLING_INVOICE_COLUMNS,
  TAX_HOLD_REASON_LABELS,
  addDays,
  berlinDate,
  buildInvoiceAmounts,
  cancellationAmounts,
  decideTax,
  invoiceFileName,
  invoicePeriodLabel,
  isMissingColumnError,
  isMissingRelationError,
  isPeriodKey,
  isVatIdAccepted,
  parseBillingAccountRow,
  parseInvoiceRow,
  HOME_COUNTRY,
  periodKeyOf,
  sellerFromRow,
  sellerMissingFields,
  sellerToRow,
  type BillingAccountRow,
  type BillingDetails,
  type BillingInvoice,
  type BillingSellerRow,
  type SellerSettings,
  type SupabaseClient,
} from '@zendori/core';
import { formatQuantity, getOrgInvoice, loadBillingCatalog, monthPeriod } from '@/lib/billing';

// Own invoices (Phase 15b, migration 0046), the app side: the seller's details,
// issuing an invoice for a customer and a month, cancelling, payment state and
// the PDF link. Service role only — every caller has done its own access check
// (platform admin, or the membership of the customer who looks at their own).
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
): Promise<{ error: boolean }> {
  const { error } = await admin.from('billing_seller').upsert(
    {
      id: true,
      ...sellerToRow(settings),
      updated_at: new Date().toISOString(),
      updated_by: userId,
    },
    { onConflict: 'id' }
  );
  return { error: Boolean(error) };
}

// --- reading invoices -------------------------------------------------------------

export interface InvoiceList {
  /** false = migration 0046 is not applied yet. */
  available: boolean;
  invoices: BillingInvoice[];
}

export async function listInvoices(
  admin: SupabaseClient,
  filter: { orgId?: string; limit?: number } = {}
): Promise<InvoiceList> {
  let query = admin
    .from('billing_invoices')
    .select(BILLING_INVOICE_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(filter.limit ?? 500);
  if (filter.orgId) query = query.eq('org_id', filter.orgId);
  const { data, error } = await query;
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
  const { data, error } = await admin
    .from('billing_invoices')
    .select(BILLING_INVOICE_COLUMNS)
    .eq('id', invoiceId)
    .maybeSingle();
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

export type IssueResult = { ok: true; invoice: BillingInvoice } | { ok: false; error: string };

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
  userId: string;
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

/**
 * Issues the invoice of one customer for one month: calculates the month as
 * the billing pages show it, freezes lines and amounts, and stores it with the
 * next number. The worker then renders the PDF and mails it to the billing
 * address. Refuses — with a sentence the operator can act on — when something
 * a correct invoice needs is missing.
 */
export async function issueInvoiceForMonth(
  admin: SupabaseClient,
  input: { orgId: string; period: string; userId: string; now?: Date }
): Promise<IssueResult> {
  const now = input.now ?? new Date();
  if (!isPeriodKey(input.period)) return { ok: false, error: 'Bitte einen Monat wählen.' };
  // only a month that is over: the running month is not complete yet
  if (input.period >= periodKeyOf(now)) {
    return {
      ok: false,
      error: `${invoicePeriodLabel(input.period)} ist noch nicht abgeschlossen. Eine Rechnung gibt es erst für einen vergangenen Monat.`,
    };
  }

  const sellerState = await loadSellerState(admin);
  if (!sellerState.available) {
    return { ok: false, error: 'Rechnungen sind noch nicht verfügbar (Migration 0046 ausstehend).' };
  }
  if (sellerState.missing.length > 0) {
    return {
      ok: false,
      error: `Beim Rechnungssteller fehlt noch: ${sellerState.missing.join(', ')}.`,
    };
  }

  const { data: accountData, error: accountError } = await admin
    .from('billing_accounts')
    .select(`${ACCOUNT_COLUMNS}, vat_id_confirmed_value`)
    .eq('org_id', input.orgId)
    .maybeSingle();
  if (accountError) return { ok: false, error: 'Die Rechnungsdaten konnten nicht gelesen werden.' };
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
      error: `Für ${invoicePeriodLabel(input.period)} ist nichts zu berechnen.`,
    };
  }

  const issueDate = berlinDate(now);
  const { data, error } = await admin.rpc(
    'issue_billing_invoice',
    issueArgs({
      orgId: input.orgId,
      kind: 'invoice',
      period: input.period,
      issueDate,
      dueDate: addDays(issueDate, sellerState.settings.paymentTermDays),
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
    })
  );
  const invoice = parseInvoiceRow((data as Record<string, unknown> | null) ?? null);
  if (error || !invoice) {
    return {
      ok: false,
      error:
        (error as { code?: string } | null)?.code === '23505'
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
    return { ok: false, error: 'Die Rechnung wurde nicht gefunden.' };
  }
  if (original.cancelledByInvoiceId) {
    return { ok: false, error: 'Diese Rechnung ist bereits storniert.' };
  }
  const sellerState = await loadSellerState(admin);
  if (sellerState.missing.length > 0) {
    return {
      ok: false,
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
  if (error || !invoice) return { ok: false, error: 'Die Rechnung konnte nicht storniert werden.' };
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
  return { error: error ? 'Der Zahlstatus konnte nicht gespeichert werden.' : null };
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
