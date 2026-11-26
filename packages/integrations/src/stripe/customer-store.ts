// The Stripe customer of an organization, per mode (billing_stripe_customers,
// migration 0041). Shared by web (the customer opens the payment page) and
// worker (sync before an invoice), so both create the customer the same way:
// same request, same idempotency key, first writer wins in the row.
import type { SupabaseClient } from '@zendori/core';
import type { StripeConfig } from './client.js';
import { createStripeCustomer } from './customers.js';

export class StripeCustomerRowMissingError extends Error {
  constructor() {
    super('No billing_stripe_customers row for this organization and mode');
    this.name = 'StripeCustomerRowMissingError';
  }
}

interface CustomerIdRow {
  stripe_customer_id: string | null;
  customer_generation: number | null;
}

async function readRow(
  supabase: SupabaseClient,
  orgId: string,
  livemode: boolean
): Promise<CustomerIdRow | null> {
  const { data, error } = await supabase
    .from('billing_stripe_customers')
    .select('stripe_customer_id, customer_generation')
    .eq('org_id', orgId)
    .eq('livemode', livemode)
    .maybeSingle();
  if (error) throw error;
  return (data as CustomerIdRow | null) ?? null;
}

/**
 * Returns the org's Stripe customer id for this mode, creating the customer if
 * there is none yet. The row must exist (the platform admin enabled Stripe
 * billing for the org in this mode).
 *
 * Safe against a parallel call: both get the same customer from Stripe (same
 * idempotency key), and only the first write into the still-empty column counts.
 */
export async function ensureStripeCustomerId(
  supabase: SupabaseClient,
  config: StripeConfig,
  input: { orgId: string; livemode: boolean; accountId?: string | null }
): Promise<string> {
  const row = await readRow(supabase, input.orgId, input.livemode);
  if (!row) throw new StripeCustomerRowMissingError();
  if (row.stripe_customer_id) return row.stripe_customer_id;

  const customer = await createStripeCustomer(config, {
    orgId: input.orgId,
    generation: row.customer_generation ?? 0,
  });

  const { error } = await supabase
    .from('billing_stripe_customers')
    .update({
      stripe_customer_id: customer.id,
      ...(input.accountId ? { stripe_account_id: input.accountId } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('org_id', input.orgId)
    .eq('livemode', input.livemode)
    .is('stripe_customer_id', null);
  if (error) throw error;

  const after = await readRow(supabase, input.orgId, input.livemode);
  if (!after?.stripe_customer_id) throw new StripeCustomerRowMissingError();
  return after.stripe_customer_id;
}
