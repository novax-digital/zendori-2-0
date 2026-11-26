// Works off the webhook inbox (stripe_events, migration 0041). The web route
// only verified the signature and stored the event id plus the ids it points
// at. Here the worker reads the CURRENT object from Stripe and copies its state
// — an event is a signal, never the source of a value, so the order in which
// Stripe delivers events does not matter and a repeated event changes nothing.
//
// The retry schedule lives in the row (attempts / next_attempt_at); the job
// itself never retries.
import { isMissingRelationError, type SupabaseClient } from '@zendori/core';
import {
  isStripeRetryable,
  retrieveCheckoutSession,
  retrieveDispute,
  retrieveMandate,
  retrieveSetupIntent,
  setDefaultPaymentMethod,
  stripeErrorCode,
  stripeEventScope,
  stripeRefId,
  type StripeSetupIntent,
} from '@zendori/integrations';
import { toErrorInfo } from '../db.js';
import {
  findCustomerRowByCustomerId,
  findCustomerRowByPaymentMethod,
  forgetStripeCustomer,
  refreshFromStripe,
  type StripeCustomerRow,
} from './account.js';
import {
  applyPaymentIntentById,
  loadCollectRow,
  markCollectionDisputed,
} from './invoice-collect.js';
import { billingNow, type BillingDeps } from './stripe.js';

export const STRIPE_EVENT_QUEUE = 'billing.stripe-event';
/** Retries are scheduled in the row — the job itself never retries. */
export const STRIPE_EVENT_RETRY_LIMIT = 0;
/** While an attempt runs, the row is invisible to the scan for this long. */
export const STRIPE_EVENT_LEASE_MS = 5 * 60_000;
/** Waiting time before attempt 2…6. After the last one the event is failed. */
export const STRIPE_EVENT_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
];
/** Handled events are kept this long as a trace. */
export const STRIPE_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface StripeEventJob {
  eventId: string;
}

interface EventRow {
  event_id: string;
  type: string;
  livemode: boolean;
  object_type: string | null;
  object_id: string | null;
  customer_id: string | null;
  attempts: number;
}

type Outcome = { kind: 'done' } | { kind: 'skipped'; reason: string };

const DONE: Outcome = { kind: 'done' };

/** The org row an event is about; null = not one of our customers. */
async function resolveRow(deps: BillingDeps, event: EventRow): Promise<StripeCustomerRow | null> {
  const { supabase, stripe } = deps;
  if (event.customer_id) {
    return findCustomerRowByCustomerId(supabase, event.customer_id, stripe.livemode);
  }
  if (event.object_type === 'payment_method' && event.object_id) {
    // a detached method no longer names its customer
    return findCustomerRowByPaymentMethod(supabase, event.object_id, stripe.livemode);
  }
  if (event.object_type === 'mandate' && event.object_id) {
    const mandate = await retrieveMandate(stripe.config, event.object_id);
    const paymentMethodId = stripeRefId(mandate?.payment_method);
    return paymentMethodId
      ? findCustomerRowByPaymentMethod(supabase, paymentMethodId, stripe.livemode)
      : null;
  }
  return null;
}

/**
 * A finished setup: make the stored method the customer's default for invoices
 * (Checkout attaches it but does not do that), then copy the state.
 */
async function applySetupIntent(
  deps: BillingDeps,
  row: StripeCustomerRow,
  setupIntent: StripeSetupIntent
): Promise<Outcome> {
  if (setupIntent.status !== 'succeeded') {
    // not finished yet — setup_intent.succeeded follows
    return { kind: 'skipped', reason: 'setup_not_succeeded' };
  }
  const customerId = row.stripe_customer_id;
  const paymentMethodId = stripeRefId(setupIntent.payment_method);
  if (!customerId || !paymentMethodId) return { kind: 'skipped', reason: 'no_payment_method' };
  // The intent must belong to this customer — never trust the pairing blindly.
  if (stripeRefId(setupIntent.customer) !== customerId) {
    return { kind: 'skipped', reason: 'foreign_customer' };
  }
  await setDefaultPaymentMethod(deps.stripe.config, customerId, paymentMethodId);
  await refreshOrForget(deps, row);
  return DONE;
}

async function refreshOrForget(deps: BillingDeps, row: StripeCustomerRow): Promise<void> {
  const state = await refreshFromStripe(deps, row);
  if (state === 'customer_missing') await forgetStripeCustomer(deps, row);
}

async function handleAccountEvent(deps: BillingDeps, event: EventRow): Promise<Outcome> {
  const { stripe } = deps;

  if (event.type === 'checkout.session.completed') {
    if (!event.object_id) return { kind: 'skipped', reason: 'no_object' };
    const session = await retrieveCheckoutSession(stripe.config, event.object_id);
    if (session.mode !== 'setup') return { kind: 'skipped', reason: 'not_setup' };
    const customerId = stripeRefId(session.customer);
    const row = customerId
      ? await findCustomerRowByCustomerId(deps.supabase, customerId, stripe.livemode)
      : null;
    if (!row) return { kind: 'skipped', reason: 'unknown_customer' };
    const reference = session.setup_intent ?? null;
    if (!reference) return { kind: 'skipped', reason: 'no_setup_intent' };
    const setupIntent =
      typeof reference === 'string'
        ? await retrieveSetupIntent(stripe.config, reference)
        : reference;
    return applySetupIntent(deps, row, setupIntent);
  }

  if (event.type === 'setup_intent.succeeded') {
    if (!event.object_id) return { kind: 'skipped', reason: 'no_object' };
    const setupIntent = await retrieveSetupIntent(stripe.config, event.object_id);
    const customerId = stripeRefId(setupIntent.customer);
    const row = customerId
      ? await findCustomerRowByCustomerId(deps.supabase, customerId, stripe.livemode)
      : null;
    if (!row) return { kind: 'skipped', reason: 'unknown_customer' };
    return applySetupIntent(deps, row, setupIntent);
  }

  const row = await resolveRow(deps, event);
  if (!row) return { kind: 'skipped', reason: 'unknown_customer' };
  // customer.deleted included: the read finds no customer and the row is cleared
  await refreshOrForget(deps, row);
  return DONE;
}

/**
 * An event about the charge of an invoice (15b step 3). The event only says
 * WHICH payment changed; what is applied is the PaymentIntent as Stripe has it
 * now. A payment that is not one of our invoices is skipped.
 */
async function handlePaymentEvent(deps: BillingDeps, event: EventRow): Promise<Outcome> {
  if (!event.object_id) return { kind: 'skipped', reason: 'no_object' };
  if (event.type === 'charge.dispute.created') {
    const dispute = await retrieveDispute(deps.stripe.config, event.object_id);
    const paymentIntentId = stripeRefId(dispute?.payment_intent);
    if (!paymentIntentId) return { kind: 'skipped', reason: 'no_payment_intent' };
    const row = await loadCollectRow(deps.supabase, { paymentIntentId });
    if (!row || row.collect_livemode !== deps.stripe.livemode) {
      return { kind: 'skipped', reason: 'not_an_invoice' };
    }
    await markCollectionDisputed(deps, row);
    return DONE;
  }
  const result = await applyPaymentIntentById(deps, event.object_id);
  return result === 'unknown' ? { kind: 'skipped', reason: 'not_an_invoice' } : DONE;
}

/**
 * One attempt for one stored event. Idempotent per attempt: only a pending
 * event whose time has come can be leased, so a duplicate job is a no-op.
 */
export async function processStripeEvent(deps: BillingDeps, eventId: string): Promise<void> {
  const { supabase, stripe, logger } = deps;
  const nowMs = billingNow(deps);
  const { data: leased, error: leaseError } = await supabase
    .from('stripe_events')
    .update({ next_attempt_at: new Date(nowMs + STRIPE_EVENT_LEASE_MS).toISOString() })
    .eq('event_id', eventId)
    .eq('state', 'pending')
    .lte('next_attempt_at', new Date(nowMs).toISOString())
    .select('event_id, type, livemode, object_type, object_id, customer_id, attempts');
  if (leaseError) throw leaseError;
  const event = ((leased ?? []) as EventRow[])[0];
  if (!event) return; // not due, already handled, or gone

  let patch: Record<string, unknown>;
  let logged: string;
  const processedAt = new Date(nowMs).toISOString();

  if (event.livemode !== stripe.livemode) {
    // an event of the other mode: this key cannot read its objects
    patch = { state: 'skipped', last_error: 'other_mode', processed_at: processedAt };
    logged = 'skipped:other_mode';
  } else if (stripeEventScope(event.type) === null) {
    patch = { state: 'skipped', last_error: 'unhandled_type', processed_at: processedAt };
    logged = 'skipped:unhandled_type';
  } else {
    try {
      const outcome =
        stripeEventScope(event.type) === 'payment'
          ? await handlePaymentEvent(deps, event)
          : await handleAccountEvent(deps, event);
      if (outcome.kind === 'done') {
        patch = {
          state: 'done',
          attempts: event.attempts + 1,
          last_error: null,
          processed_at: processedAt,
        };
        logged = 'done';
      } else {
        patch = { state: 'skipped', last_error: outcome.reason, processed_at: processedAt };
        logged = `skipped:${outcome.reason}`;
      }
    } catch (err) {
      const attempts = event.attempts + 1;
      const code = stripeErrorCode(err);
      const delay = STRIPE_EVENT_RETRY_DELAYS_MS[attempts - 1];
      // a 4xx says the request itself is wrong: trying again changes nothing
      const hopeless = code.startsWith('stripe:') && !isStripeRetryable(err);
      if (hopeless || delay === undefined) {
        patch = { state: 'failed', attempts, last_error: code, processed_at: processedAt };
        logged = `failed:${code}`;
      } else {
        patch = {
          attempts,
          last_error: code,
          next_attempt_at: new Date(nowMs + delay).toISOString(),
        };
        logged = `retry:${code}`;
      }
      logger.warn(
        { eventType: event.type, outcome: logged, attempts, err: toErrorInfo(err) },
        'stripe event attempt failed'
      );
    }
  }

  const { error: updateError } = await supabase
    .from('stripe_events')
    .update(patch)
    .eq('event_id', event.event_id);
  if (updateError) throw updateError;
  logger.info({ eventType: event.type, outcome: logged }, 'stripe event');
}

/** Forget handled events after the retention window (and stuck ones with them). */
export async function pruneStripeEvents(
  supabase: SupabaseClient,
  nowMs: number = Date.now()
): Promise<void> {
  const cutoff = new Date(nowMs - STRIPE_EVENT_RETENTION_MS).toISOString();
  const { error } = await supabase.from('stripe_events').delete().lt('created_at', cutoff);
  if (error && !isMissingRelationError(error)) throw error;
}
