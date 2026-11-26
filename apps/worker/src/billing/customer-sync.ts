// Brings the Stripe customer of an organization up to date (Phase 15a).
//
// The web app only writes Zendori's own tables and sets
// billing_stripe_customers.sync_requested_at; this job does the Stripe work:
// create the customer if there is none, push name / address / tax flag / VAT
// id, then read back the default payment method and the VAT id check.
//
// The request stays in the row until it is done. A failed attempt is retried on
// a schedule kept in the row (sync_attempts / sync_next_attempt_at); the job
// itself never retries. Nothing here logs an address or a VAT id (§7).
import { customerTaxExempt, parseBillingAccountRow, type BillingAccountRow } from '@zendori/core';
import {
  StripeApiError,
  ensureStripeCustomerId,
  isStripeNotFound,
  isStripeRetryable,
  stripeErrorCode,
  syncCustomerVatId,
  updateStripeCustomer,
} from '@zendori/integrations';
import { toErrorInfo } from '../db.js';
import {
  forgetStripeCustomer,
  loadCustomerRow,
  refreshFromStripe,
  type StripeCustomerRow,
} from './account.js';
import { billingAccountId, billingNow, type BillingDeps } from './stripe.js';

export const BILLING_SYNC_QUEUE = 'billing.customer-sync';
/** Retries are scheduled in the row — the job itself never retries. */
export const BILLING_SYNC_RETRY_LIMIT = 0;
/** While an attempt runs, the row is not offered again for this long. */
export const BILLING_SYNC_LEASE_MS = 5 * 60_000;
/** Waiting time before attempt 2, 3, 4, 5. After the last one the request is dropped. */
export const BILLING_SYNC_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
];

export interface BillingSyncJob {
  orgId: string;
}

/** Is a requested sync due at `nowMs`? (Also used by the scan.) */
export function isBillingSyncDue(
  row: { sync_requested_at: string | null; sync_next_attempt_at: string | null },
  nowMs: number
): boolean {
  if (!row.sync_requested_at) return false;
  if (!row.sync_next_attempt_at) return true;
  return Date.parse(row.sync_next_attempt_at) <= nowMs;
}

const ACCOUNT_COLUMNS =
  'legal_name, address_line1, address_line2, postal_code, city, country, vat_id, billing_email';

async function runSync(deps: BillingDeps, row: StripeCustomerRow): Promise<void> {
  const { supabase, stripe } = deps;
  // Which Stripe account the key belongs to. A restricted key may not be allowed
  // to read that — then the check below is skipped instead of blocking the sync.
  let accountId: string | null;
  try {
    accountId = await billingAccountId(deps);
  } catch (error) {
    if (!(error instanceof StripeApiError) || isStripeRetryable(error)) throw error;
    accountId = null;
  }

  let current = row;
  if (
    accountId !== null &&
    current.stripe_customer_id &&
    current.stripe_account_id &&
    current.stripe_account_id !== accountId
  ) {
    // The key belongs to another Stripe account than the one this customer was
    // created in. In live mode that must be looked at by a human; a test key
    // from a new sandbox simply starts over.
    if (stripe.livemode) throw new AccountMismatchError();
    await forgetStripeCustomer(deps, current);
    current = (await loadCustomerRow(supabase, row.org_id, row.livemode)) ?? current;
  }

  let customerId = await ensureStripeCustomerId(supabase, stripe.config, {
    orgId: row.org_id,
    livemode: row.livemode,
    accountId,
  });
  current = (await loadCustomerRow(supabase, row.org_id, row.livemode)) ?? current;
  // switched off while this attempt was running: no details leave for Stripe
  if (!current.enabled) return;

  const { data: accountData, error: accountError } = await supabase
    .from('billing_accounts')
    .select(ACCOUNT_COLUMNS)
    .eq('org_id', row.org_id)
    .maybeSingle();
  if (accountError) throw accountError;
  const details = parseBillingAccountRow((accountData as BillingAccountRow | null) ?? null);

  const push = async (id: string): Promise<'ok' | 'customer_missing'> => {
    try {
      if (details) {
        await updateStripeCustomer(stripe.config, id, {
          name: details.legalName,
          email: details.billingEmail,
          address: {
            line1: details.addressLine1,
            line2: details.addressLine2 === '' ? null : details.addressLine2,
            postalCode: details.postalCode,
            city: details.city,
            country: details.country,
          },
          taxExempt: customerTaxExempt(details),
        });
        await syncCustomerVatId(stripe.config, id, details.vatId === '' ? null : details.vatId);
      }
      return await refreshFromStripe(deps, { ...current, stripe_customer_id: id });
    } catch (error) {
      // "No such customer": it was deleted in the Stripe dashboard
      if (isStripeNotFound(error)) return 'customer_missing';
      throw error;
    }
  };

  let state = await push(customerId);
  if (state === 'customer_missing') {
    // create a new one, under a new idempotency key (the old key would replay
    // the deleted customer)
    await forgetStripeCustomer(deps, { ...current, stripe_customer_id: customerId });
    customerId = await ensureStripeCustomerId(supabase, stripe.config, {
      orgId: row.org_id,
      livemode: row.livemode,
      accountId,
    });
    current = (await loadCustomerRow(supabase, row.org_id, row.livemode)) ?? current;
    state = await push(customerId);
    if (state === 'customer_missing') throw new Error('stripe customer vanished during sync');
  }

  if (accountId !== null && !current.stripe_account_id) {
    const { error } = await supabase
      .from('billing_stripe_customers')
      .update({ stripe_account_id: accountId })
      .eq('org_id', row.org_id)
      .eq('livemode', row.livemode)
      .is('stripe_account_id', null);
    if (error) throw error;
  }
}

class AccountMismatchError extends Error {
  constructor() {
    super('The Stripe key belongs to another account than the stored customer');
    this.name = 'AccountMismatchError';
  }
}

/**
 * One attempt to work off a requested sync. A no-op when nothing is requested,
 * the attempt is not due yet, or the row belongs to the other mode.
 *
 * A customer the operator switched OFF is never synced: a request that is
 * still open — also one waiting for a retry — is dropped, so nothing about a
 * customer that is not billed through Stripe is sent there.
 */
export async function syncBillingCustomer(deps: BillingDeps, orgId: string): Promise<void> {
  const { supabase, stripe, logger } = deps;
  const nowMs = billingNow(deps);
  const row = await loadCustomerRow(supabase, orgId, stripe.livemode);
  if (!row || !row.sync_requested_at) return;
  if (!row.enabled) {
    const { error: dropError } = await supabase
      .from('billing_stripe_customers')
      .update({ sync_requested_at: null, sync_next_attempt_at: null, sync_attempts: 0 })
      .eq('org_id', orgId)
      .eq('livemode', stripe.livemode)
      .eq('enabled', false)
      .eq('sync_requested_at', row.sync_requested_at);
    if (dropError) throw dropError;
    logger.info({ orgId, livemode: stripe.livemode }, 'billing customer sync dropped: not enabled');
    return;
  }
  if (!isBillingSyncDue(row, nowMs)) return;
  const requestedAt = row.sync_requested_at;

  // Lease: an attempt that dies is offered again after the lease.
  const { error: leaseError } = await supabase
    .from('billing_stripe_customers')
    .update({ sync_next_attempt_at: new Date(nowMs + BILLING_SYNC_LEASE_MS).toISOString() })
    .eq('org_id', orgId)
    .eq('livemode', stripe.livemode)
    .eq('sync_requested_at', requestedAt);
  if (leaseError) throw leaseError;

  try {
    await runSync(deps, row);
  } catch (err) {
    const attempts = (row.sync_attempts ?? 0) + 1;
    const delay = BILLING_SYNC_RETRY_DELAYS_MS[attempts - 1];
    const code = err instanceof AccountMismatchError ? 'account_mismatch' : stripeErrorCode(err);
    const giveUp =
      err instanceof AccountMismatchError ||
      delay === undefined ||
      // a 4xx says the request itself is wrong: trying again changes nothing
      (code.startsWith('stripe:') && !isStripeRetryable(err));
    const patch: Record<string, unknown> = { sync_attempts: attempts, sync_error: code };
    if (giveUp) {
      patch.sync_requested_at = null;
      patch.sync_next_attempt_at = null;
    } else {
      patch.sync_next_attempt_at = new Date(nowMs + (delay ?? 0)).toISOString();
    }
    const { error: failError } = await supabase
      .from('billing_stripe_customers')
      .update(patch)
      .eq('org_id', orgId)
      .eq('livemode', stripe.livemode)
      .eq('sync_requested_at', requestedAt);
    if (failError) throw failError;
    logger.warn(
      {
        orgId,
        livemode: stripe.livemode,
        attempts,
        outcome: giveUp ? 'gave_up' : 'retry',
        code,
        err: toErrorInfo(err),
      },
      'billing customer sync failed'
    );
    return;
  }

  // Done. A request that came in while this attempt ran (newer timestamp) stays
  // and is worked off next — only its retry bookkeeping is reset.
  const { error: clearError } = await supabase
    .from('billing_stripe_customers')
    .update({ sync_requested_at: null })
    .eq('org_id', orgId)
    .eq('livemode', stripe.livemode)
    .eq('sync_requested_at', requestedAt);
  if (clearError) throw clearError;
  const { error: resetError } = await supabase
    .from('billing_stripe_customers')
    .update({ sync_attempts: 0, sync_next_attempt_at: null, sync_error: null })
    .eq('org_id', orgId)
    .eq('livemode', stripe.livemode);
  if (resetError) throw resetError;

  logger.info({ orgId, livemode: stripe.livemode }, 'billing customer synced');
}
