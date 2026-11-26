// Stripe configuration of the worker (Phase 15). Without STRIPE_SECRET_KEY the
// worker does nothing Stripe-related. The key's prefix decides test vs. live;
// every billing row carries the mode it belongs to, and the worker only ever
// touches rows of its own mode.
import { loadWorkerEnv, type Logger, type SupabaseClient } from '@zendori/core';
import { retrieveStripeAccount, stripeKeyLivemode, type StripeConfig } from '@zendori/integrations';

export interface StripeRuntime {
  config: StripeConfig;
  livemode: boolean;
}

let cached: StripeRuntime | null | undefined;

/** null = Stripe is not configured (or the value is not a secret key). */
export function workerStripe(): StripeRuntime | null {
  if (cached !== undefined) return cached;
  const secretKey = loadWorkerEnv().STRIPE_SECRET_KEY;
  const livemode = secretKey ? stripeKeyLivemode(secretKey) : null;
  cached = secretKey && livemode !== null ? { config: { secretKey }, livemode } : null;
  return cached;
}

let accountIdPromise: Promise<string> | undefined;

/** The Stripe account the key belongs to (asked once per process). */
export function workerStripeAccountId(runtime: StripeRuntime): Promise<string> {
  if (!accountIdPromise) {
    accountIdPromise = retrieveStripeAccount(runtime.config)
      .then((account) => account.id)
      .catch((error: unknown) => {
        // do not cache a failure
        accountIdPromise = undefined;
        throw error;
      });
  }
  return accountIdPromise;
}

/** What every billing job gets. */
export interface BillingDeps {
  supabase: SupabaseClient;
  logger: Logger;
  stripe: StripeRuntime;
  /** Injectable for tests. */
  now?: () => number;
  /** The Stripe account of the key; injectable for tests. */
  accountId?: () => Promise<string>;
}

export function billingNow(deps: BillingDeps): number {
  return (deps.now ?? Date.now)();
}

export function billingAccountId(deps: BillingDeps): Promise<string> {
  return deps.accountId ? deps.accountId() : workerStripeAccountId(deps.stripe);
}
