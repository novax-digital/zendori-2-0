import 'server-only';
import {
  billingDetailsToRow,
  isMissingColumnError,
  isMissingRelationError,
  isPaymentMethodType,
  isPeriodKey,
  isVatIdStatus,
  parseBillingAccountRow,
  type BillingAccountRow,
  type BillingDetails,
  type PaymentMethodType,
  type SupabaseClient,
  type VatIdCheck,
  type VatIdStatus,
} from '@zendori/core';

// Billing details + the Stripe side of an organization (migration 0041), read
// with the service role behind the caller's access check: the customer page
// verifies the membership (requireActiveOrg), the admin pages the platform admin.
// Both tables are service-role only; before the migration everything reads as
// "not available" and the pages look as they did.

export interface StripeCustomerState {
  enabled: boolean;
  /** First billing month invoiced through Stripe (YYYY-MM). */
  invoiceFrom: string | null;
  stripeCustomerId: string | null;
  paymentMethodId: string | null;
  paymentMethodType: PaymentMethodType | null;
  paymentMethodLabel: string | null;
  vatIdValue: string | null;
  vatIdStatus: VatIdStatus | null;
  vatIdConfirmedValue: string | null;
  /** The worker has not yet brought Stripe up to date. */
  syncPending: boolean;
  syncError: string | null;
  syncedAt: string | null;
}

export interface BillingAccountState {
  /** false = migration 0041 is not applied yet. */
  available: boolean;
  /** Complete and valid details, else null. */
  details: BillingDetails | null;
  /** What is stored, complete or not (to prefill the form). */
  stored: BillingAccountRow | null;
  /** The row of the given mode; null = never enabled in this mode. */
  stripe: StripeCustomerState | null;
}

const ACCOUNT_COLUMNS =
  'legal_name, address_line1, address_line2, postal_code, city, country, vat_id, billing_email';
const STRIPE_COLUMNS =
  'enabled, invoice_from, stripe_customer_id, payment_method_id, payment_method_type, payment_method_label, vat_id_value, vat_id_status, vat_id_confirmed_value, sync_requested_at, sync_error, synced_at';

interface StripeRow {
  enabled: boolean;
  invoice_from: string | null;
  stripe_customer_id: string | null;
  payment_method_id: string | null;
  payment_method_type: string | null;
  payment_method_label: string | null;
  vat_id_value: string | null;
  vat_id_status: string | null;
  vat_id_confirmed_value: string | null;
  sync_requested_at: string | null;
  sync_error: string | null;
  synced_at: string | null;
}

function toStripeState(row: StripeRow): StripeCustomerState {
  return {
    enabled: row.enabled === true,
    invoiceFrom: isPeriodKey(row.invoice_from) ? row.invoice_from : null,
    stripeCustomerId: row.stripe_customer_id,
    paymentMethodId: row.payment_method_id,
    paymentMethodType: isPaymentMethodType(row.payment_method_type)
      ? row.payment_method_type
      : null,
    paymentMethodLabel: row.payment_method_label,
    vatIdValue: row.vat_id_value,
    vatIdStatus: isVatIdStatus(row.vat_id_status) ? row.vat_id_status : null,
    vatIdConfirmedValue: row.vat_id_confirmed_value,
    syncPending: row.sync_requested_at !== null,
    syncError: row.sync_error,
    syncedAt: row.synced_at,
  };
}

const UNAVAILABLE: BillingAccountState = {
  available: false,
  details: null,
  stored: null,
  stripe: null,
};

export async function loadBillingAccountState(
  admin: SupabaseClient,
  orgId: string,
  livemode: boolean
): Promise<BillingAccountState> {
  const [account, stripe] = await Promise.all([
    admin.from('billing_accounts').select(ACCOUNT_COLUMNS).eq('org_id', orgId).maybeSingle(),
    admin
      .from('billing_stripe_customers')
      .select(STRIPE_COLUMNS)
      .eq('org_id', orgId)
      .eq('livemode', livemode)
      .maybeSingle(),
  ]);
  if (account.error || stripe.error) {
    const error = account.error ?? stripe.error;
    if (error && isMissingRelationError(error)) return UNAVAILABLE;
    // a read problem must not take the billing page down — behave as "not set up"
    return UNAVAILABLE;
  }
  const stored = (account.data as BillingAccountRow | null) ?? null;
  return {
    available: true,
    details: parseBillingAccountRow(stored),
    stored,
    stripe: stripe.data ? toStripeState(stripe.data as StripeRow) : null,
  };
}

/** What is known about the check of the VAT id that is on file now. */
export function vatIdCheckOf(vatId: string, stripe: StripeCustomerState | null): VatIdCheck | null {
  if (!stripe || vatId === '') return null;
  if (stripe.vatIdConfirmedValue === vatId) {
    return {
      value: vatId,
      status: stripe.vatIdValue === vatId ? stripe.vatIdStatus : null,
      confirmed: true,
    };
  }
  return { value: stripe.vatIdValue, status: stripe.vatIdStatus, confirmed: false };
}

/** Marker in the Stripe dashboard URL for test-mode objects. */
export function stripeDashboardCustomerUrl(customerId: string, livemode: boolean): string {
  return `https://dashboard.stripe.com/${livemode ? '' : 'test/'}customers/${encodeURIComponent(customerId)}`;
}

// --- writes -------------------------------------------------------------------

/** Reads the billing details out of a submitted form (both drawers use the same names). */
export function billingDetailsFromForm(formData: FormData): Record<string, string> {
  const text = (name: string): string => {
    const value = formData.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };
  return {
    legalName: text('legalName'),
    addressLine1: text('addressLine1'),
    addressLine2: text('addressLine2'),
    postalCode: text('postalCode'),
    city: text('city'),
    country: text('country'),
    vatId: text('vatId'),
    billingEmail: text('billingEmail'),
  };
}

// --- the e-mail that asks the customer to set up billing (migration 0044) -------

export interface SetupMailState {
  /** false = migration 0044 is not applied yet (or the row could not be read). */
  available: boolean;
  /** A mail is waiting for the worker. */
  pending: boolean;
  sentAt: string | null;
  /** Why the last request sent nothing; null = no problem. */
  error: string | null;
}

const NO_SETUP_MAIL: SetupMailState = {
  available: false,
  pending: false,
  sentAt: null,
  error: null,
};

/** What the worker stores as the reason, in words for the operator. */
const SETUP_MAIL_ERROR_LABELS: Record<string, string> = {
  disabled: 'die Stripe-Abrechnung war ausgeschaltet',
  sync_failed: 'der Abgleich mit Stripe ist fehlgeschlagen',
  no_recipient: 'kein Inhaber oder Admin mit E-Mail-Adresse',
  not_configured: 'im Worker fehlt der Absender (RESEND_FROM)',
  send_failed: 'der Versand ist fehlgeschlagen',
};

export function setupMailErrorLabel(code: string): string {
  return SETUP_MAIL_ERROR_LABELS[code] ?? code;
}

/** The setup mail of one org in one Stripe mode. Separate from the state above so a missing 0044 changes nothing else. */
export async function loadSetupMailState(
  admin: SupabaseClient,
  orgId: string,
  livemode: boolean
): Promise<SetupMailState> {
  const { data, error } = await admin
    .from('billing_stripe_customers')
    .select('setup_mail_requested_at, setup_mail_sent_at, setup_mail_error')
    .eq('org_id', orgId)
    .eq('livemode', livemode)
    .maybeSingle();
  if (error) return NO_SETUP_MAIL;
  const row = data as {
    setup_mail_requested_at: string | null;
    setup_mail_sent_at: string | null;
    setup_mail_error: string | null;
  } | null;
  return {
    available: true,
    pending: (row?.setup_mail_requested_at ?? null) !== null,
    sentAt: row?.setup_mail_sent_at ?? null,
    error: row?.setup_mail_error ?? null,
  };
}

/**
 * Sets or withdraws the request for the setup mail in one Stripe mode. The
 * worker sends it after the next sync (requestBillingSync), to owners and
 * admins, and only while billing details or payment method are missing.
 */
export async function setSetupMailRequest(
  admin: SupabaseClient,
  orgId: string,
  livemode: boolean,
  requested: boolean
): Promise<{ error: boolean; unavailable: boolean }> {
  const { error } = await admin
    .from('billing_stripe_customers')
    .update(
      requested
        ? { setup_mail_requested_at: new Date().toISOString(), setup_mail_error: null }
        : { setup_mail_requested_at: null }
    )
    .eq('org_id', orgId)
    .eq('livemode', livemode);
  if (error && isMissingColumnError(error)) return { error: false, unavailable: true };
  return { error: Boolean(error), unavailable: false };
}

/**
 * Asks the worker to bring Stripe up to date for this org. Only rows the
 * operator enabled; every mode that is enabled gets the request, and the worker
 * of each mode works off its own.
 */
export async function requestBillingSync(
  admin: SupabaseClient,
  orgId: string
): Promise<{ error: boolean }> {
  const { error } = await admin
    .from('billing_stripe_customers')
    .update({
      sync_requested_at: new Date().toISOString(),
      sync_attempts: 0,
      sync_next_attempt_at: null,
      sync_error: null,
    })
    .eq('org_id', orgId)
    .eq('enabled', true);
  return { error: Boolean(error) };
}

/**
 * Withdraws a sync that is still open in one Stripe mode — called when the
 * operator switches Stripe billing OFF, so nothing about this customer is sent
 * to Stripe afterwards (the worker drops such a request too, should one slip
 * through). What Stripe already has stays as it is.
 */
export async function cancelBillingSync(
  admin: SupabaseClient,
  orgId: string,
  livemode: boolean
): Promise<{ error: boolean }> {
  const { error } = await admin
    .from('billing_stripe_customers')
    .update({
      sync_requested_at: null,
      sync_attempts: 0,
      sync_next_attempt_at: null,
      sync_error: null,
    })
    .eq('org_id', orgId)
    .eq('livemode', livemode);
  return { error: Boolean(error) };
}

/**
 * Stores the billing details. A changed VAT id invalidates what was known about
 * the old one — the operator's manual confirmation included.
 */
export async function saveBillingDetailsRow(
  admin: SupabaseClient,
  input: { orgId: string; details: BillingDetails; userId: string }
): Promise<{ error: boolean }> {
  const { data: before } = await admin
    .from('billing_accounts')
    .select('vat_id')
    .eq('org_id', input.orgId)
    .maybeSingle();
  const previousVatId = (before as { vat_id: string | null } | null)?.vat_id ?? null;

  const nowIso = new Date().toISOString();
  const { error } = await admin.from('billing_accounts').upsert(
    {
      org_id: input.orgId,
      ...billingDetailsToRow(input.details),
      updated_at: nowIso,
      updated_by: input.userId,
    },
    { onConflict: 'org_id' }
  );
  if (error) return { error: true };

  const vatId = input.details.vatId === '' ? null : input.details.vatId;
  if (vatId !== previousVatId) {
    const { error: resetError } = await admin
      .from('billing_stripe_customers')
      .update({
        vat_id_value: null,
        vat_id_status: null,
        vat_id_confirmed_value: null,
        vat_id_confirmed_by: null,
        vat_id_confirmed_at: null,
        updated_at: nowIso,
      })
      .eq('org_id', input.orgId);
    if (resetError) return { error: true };
  }
  return requestBillingSync(admin, input.orgId);
}
