// The Stripe side of an organization as the worker sees it
// (billing_stripe_customers, migration 0041): lookups and the one function that
// copies the current state from Stripe into the row.
//
// Values always come from a fresh read of the Stripe object, never from an
// event — events are only the signal that something changed.
import {
  isPaymentMethodType,
  isVatIdStatus,
  paymentMethodLabel,
  type SupabaseClient,
} from '@zendori/core';
import {
  STRIPE_EU_VAT_TYPE,
  listCustomerTaxIds,
  retrievePaymentMethod,
  retrieveStripeCustomer,
  type StripePaymentMethod,
} from '@zendori/integrations';
import { billingNow, type BillingDeps } from './stripe.js';

export interface StripeCustomerRow {
  org_id: string;
  livemode: boolean;
  enabled: boolean;
  stripe_account_id: string | null;
  stripe_customer_id: string | null;
  customer_generation: number | null;
  payment_method_id: string | null;
  sync_requested_at: string | null;
  sync_attempts: number | null;
  sync_next_attempt_at: string | null;
}

export const STRIPE_CUSTOMER_COLUMNS =
  'org_id, livemode, enabled, stripe_account_id, stripe_customer_id, customer_generation, payment_method_id, sync_requested_at, sync_attempts, sync_next_attempt_at';

export async function loadCustomerRow(
  supabase: SupabaseClient,
  orgId: string,
  livemode: boolean
): Promise<StripeCustomerRow | null> {
  const { data, error } = await supabase
    .from('billing_stripe_customers')
    .select(STRIPE_CUSTOMER_COLUMNS)
    .eq('org_id', orgId)
    .eq('livemode', livemode)
    .maybeSingle();
  if (error) throw error;
  return (data as StripeCustomerRow | null) ?? null;
}

export async function findCustomerRowByCustomerId(
  supabase: SupabaseClient,
  customerId: string,
  livemode: boolean
): Promise<StripeCustomerRow | null> {
  const { data, error } = await supabase
    .from('billing_stripe_customers')
    .select(STRIPE_CUSTOMER_COLUMNS)
    .eq('stripe_customer_id', customerId)
    .eq('livemode', livemode)
    .maybeSingle();
  if (error) throw error;
  return (data as StripeCustomerRow | null) ?? null;
}

export async function findCustomerRowByPaymentMethod(
  supabase: SupabaseClient,
  paymentMethodId: string,
  livemode: boolean
): Promise<StripeCustomerRow | null> {
  const { data, error } = await supabase
    .from('billing_stripe_customers')
    .select(STRIPE_CUSTOMER_COLUMNS)
    .eq('payment_method_id', paymentMethodId)
    .eq('livemode', livemode)
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as StripeCustomerRow[])[0] ?? null;
}

/** The VAT id the org has on file (normalized), or null. */
async function storedVatId(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('billing_accounts')
    .select('vat_id')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw error;
  return (data as { vat_id: string | null } | null)?.vat_id ?? null;
}

function paymentFields(method: StripePaymentMethod | null): {
  payment_method_id: string | null;
  payment_method_type: string | null;
  payment_method_label: string | null;
} {
  if (!method) {
    return { payment_method_id: null, payment_method_type: null, payment_method_label: null };
  }
  if (isPaymentMethodType(method.type)) {
    const last4 = method.type === 'card' ? method.card?.last4 : method.sepa_debit?.last4;
    return {
      payment_method_id: method.id,
      payment_method_type: method.type,
      payment_method_label: paymentMethodLabel(method.type, {
        brand: method.card?.brand,
        last4,
      }),
    };
  }
  // a method of another kind was made the default in the Stripe dashboard
  return {
    payment_method_id: method.id,
    payment_method_type: null,
    payment_method_label: 'Andere Zahlungsart',
  };
}

/** Clears what belonged to a customer that no longer exists in Stripe. */
export async function forgetStripeCustomer(
  deps: BillingDeps,
  row: StripeCustomerRow
): Promise<void> {
  const { error } = await deps.supabase
    .from('billing_stripe_customers')
    .update({
      stripe_customer_id: null,
      // the next creating request needs a new idempotency key
      customer_generation: (row.customer_generation ?? 0) + 1,
      payment_method_id: null,
      payment_method_type: null,
      payment_method_label: null,
      vat_id_value: null,
      vat_id_status: null,
      updated_at: new Date(billingNow(deps)).toISOString(),
    })
    .eq('org_id', row.org_id)
    .eq('livemode', row.livemode)
    .eq('stripe_customer_id', row.stripe_customer_id);
  if (error) throw error;
}

/**
 * Copies the default payment method and the VAT id check of the Stripe customer
 * into the row. Returns 'customer_missing' when the customer does not exist for
 * this key (deleted in Stripe) — the caller decides what follows.
 */
export async function refreshFromStripe(
  deps: BillingDeps,
  row: StripeCustomerRow
): Promise<'ok' | 'customer_missing'> {
  if (!row.stripe_customer_id) return 'customer_missing';
  const { config } = deps.stripe;
  const customer = await retrieveStripeCustomer(config, row.stripe_customer_id);
  if (!customer) return 'customer_missing';

  const defaultMethod = customer.invoice_settings?.default_payment_method ?? null;
  const method =
    typeof defaultMethod === 'string'
      ? await retrievePaymentMethod(config, defaultMethod)
      : defaultMethod;

  const vatId = await storedVatId(deps.supabase, row.org_id);
  const taxIds = (await listCustomerTaxIds(config, row.stripe_customer_id)).filter(
    (taxId) => taxId.type === STRIPE_EU_VAT_TYPE
  );
  // the check only counts for the VAT id that is on file now
  const taxId = taxIds.find((candidate) => candidate.value === vatId) ?? null;
  const status = taxId?.verification?.status;

  const nowIso = new Date(billingNow(deps)).toISOString();
  const { error } = await deps.supabase
    .from('billing_stripe_customers')
    .update({
      ...paymentFields(method),
      vat_id_value: taxId ? taxId.value : null,
      vat_id_status: isVatIdStatus(status) ? status : null,
      synced_at: nowIso,
      updated_at: nowIso,
    })
    .eq('org_id', row.org_id)
    .eq('livemode', row.livemode)
    .eq('stripe_customer_id', row.stripe_customer_id);
  if (error) throw error;
  return 'ok';
}
