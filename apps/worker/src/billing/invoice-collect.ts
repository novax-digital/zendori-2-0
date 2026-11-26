// Collecting an invoice through Stripe (Phase 15b step 3, migration 0048).
//
// An invoice of a customer who is billed through Stripe says "we collect the
// amount on <date>". On that date this module charges the payment method the
// customer stored: one PaymentIntent, confirmed at once. Afterwards it follows
// what Stripe says about that payment — through events (stripe-events.ts) and,
// as a net under them, by asking Stripe once a day while a debit is under way.
//
//   collect_state   scheduled → processing → succeeded
//                           ↘ failed          (declined, no payment method, …)
//                   succeeded → disputed      (reversed later)
//
// Rules (owner decisions 2026-11-27):
//   · a failed or reversed charge leaves the invoice OPEN and mails the operator;
//     there is no automatic second attempt — the operator asks for one;
//   · a cancelled or already paid invoice is never charged.
//
// Never twice: the request carries an idempotency key of invoice + attempt, and
// before a charge is created for an attempt that was begun earlier (a crash
// between Stripe and the database), Stripe is asked whether that charge exists.
// Values always come from a fresh read of the PaymentIntent, never from an event.
import {
  berlinDate,
  collectErrorLabel,
  formatCentsEur,
  isMissingColumnError,
  isMissingRelationError,
  type Logger,
  type SupabaseClient,
} from '@zendori/core';
import {
  STRIPE_INVOICE_METADATA_KEY,
  StripeApiError,
  createInvoicePaymentIntent,
  isStripeRetryable,
  listCustomerPaymentIntents,
  retrievePaymentIntent,
  stripeRefId,
  type StripePaymentIntent,
} from '@zendori/integrations';
import {
  isSuppressedEmailRecipient,
  renderCollectionProblemEmail,
  sendEmail,
  type SendEmailParams,
} from '@zendori/channels';
import { toErrorInfo } from '../db.js';
import type { StripeRuntime } from './stripe.js';

export const INVOICE_COLLECT_QUEUE = 'billing.invoice-collect';
export const INVOICE_COLLECT_RETRY_LIMIT = 0;
/** While an attempt runs, the row is invisible to the scan for this long. */
export const INVOICE_COLLECT_LEASE_MS = 10 * 60_000;
/** After a Stripe outage the charge is tried again after this long (same idempotency key). */
export const INVOICE_COLLECT_OUTAGE_RETRY_MS = 30 * 60_000;
/** A debit that is under way is looked at again after this long, events or not. */
export const INVOICE_COLLECT_RECHECK_MS = 24 * 60 * 60_000;

const DEFAULT_APP_URL = 'https://app.zendori.ai';

export interface InvoiceCollectJob {
  invoiceId: string;
}

export interface CollectDeps {
  supabase: SupabaseClient;
  logger: Logger;
  stripe: StripeRuntime;
  /** Sender address (RESEND_FROM) and app URL (APP_URL) for the mail to the operator. */
  from?: string | undefined;
  appUrl?: string | undefined;
  /** Injectable for tests. */
  send?: (params: SendEmailParams) => Promise<unknown>;
  now?: () => number;
}

export interface CollectRow {
  id: string;
  org_id: string | null;
  kind: string;
  number: string;
  gross_cents: number;
  payment_status: string;
  cancelled_by_invoice_id: string | null;
  payment_method: string;
  collect_on: string | null;
  collect_state: string;
  collect_livemode: boolean | null;
  collect_attempts: number;
  collect_started_at: string | null;
  collect_next_attempt_at: string | null;
  stripe_payment_intent_id: string | null;
  seller: { email?: string } | null;
  recipient: { legalName?: string } | null;
}

export const COLLECT_COLUMNS =
  'id, org_id, kind, number, gross_cents, payment_status, cancelled_by_invoice_id, payment_method, collect_on, collect_state, collect_livemode, collect_attempts, collect_started_at, collect_next_attempt_at, stripe_payment_intent_id, seller, recipient';

const nowOf = (deps: CollectDeps): number => (deps.now ?? Date.now)();

/** Is there collection work on this invoice that is due at `nowMs`? (Also used by the scan.) */
export function isInvoiceCollectionDue(
  row: Pick<CollectRow, 'collect_state' | 'collect_on' | 'collect_next_attempt_at'>,
  nowMs: number
): boolean {
  if (row.collect_state !== 'scheduled' && row.collect_state !== 'processing') return false;
  if (row.collect_next_attempt_at && Date.parse(row.collect_next_attempt_at) > nowMs) return false;
  // a charge never starts before the day the invoice announced
  if (row.collect_state === 'scheduled') {
    return row.collect_on !== null && row.collect_on <= berlinDate(new Date(nowMs));
  }
  return true;
}

export async function loadCollectRow(
  supabase: SupabaseClient,
  filter: { id: string } | { paymentIntentId: string }
): Promise<CollectRow | null> {
  const query = supabase.from('billing_invoices').select(COLLECT_COLUMNS);
  const { data, error } = await ('id' in filter
    ? query.eq('id', filter.id)
    : query.eq('stripe_payment_intent_id', filter.paymentIntentId)
  ).maybeSingle();
  if (error) {
    // before migration 0048 there is nothing to collect
    if (isMissingRelationError(error) || isMissingColumnError(error)) return null;
    throw error;
  }
  return (data as CollectRow | null) ?? null;
}

async function patch(
  deps: CollectDeps,
  invoiceId: string,
  values: Record<string, unknown>
): Promise<void> {
  const { error } = await deps.supabase.from('billing_invoices').update(values).eq('id', invoiceId);
  if (error) throw error;
}

/** Tells the operator that a charge failed or was reversed. Best effort: a mail problem never blocks the state. */
async function notifyOperator(
  deps: CollectDeps,
  row: CollectRow,
  kind: 'failed' | 'disputed',
  reason: string | null
): Promise<void> {
  const to = row.seller?.email?.trim() ?? '';
  if (!deps.from || to === '' || isSuppressedEmailRecipient(to)) return;
  try {
    const appUrl = (deps.appUrl ?? DEFAULT_APP_URL).replace(/\/+$/, '');
    const rendered = renderCollectionProblemEmail({
      kind,
      number: row.number,
      customerName: row.recipient?.legalName ?? 'Kunde',
      grossText: formatCentsEur(row.gross_cents),
      reasonText: collectErrorLabel(reason),
      openUrl: `${appUrl}/admin/invoices?status=open`,
      appUrl,
      livemode: deps.stripe.livemode,
    });
    await (deps.send ?? sendEmail)({
      from: deps.from,
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
  } catch (err) {
    deps.logger.warn(
      { invoiceId: row.id, kind, err: toErrorInfo(err) },
      'collection problem mail failed'
    );
  }
}

/** The charge did not go through: the invoice stays open, the operator is told once. */
export async function markCollectionFailed(
  deps: CollectDeps,
  row: CollectRow,
  reason: string,
  paymentIntentId: string | null = null
): Promise<void> {
  const wasFailed = row.collect_state === 'failed';
  await patch(deps, row.id, {
    collect_state: 'failed',
    collect_error: reason.slice(0, 120),
    collect_next_attempt_at: null,
    collect_started_at: null,
    ...(paymentIntentId ? { stripe_payment_intent_id: paymentIntentId } : {}),
  });
  deps.logger.info({ invoiceId: row.id, reason }, 'invoice collection failed');
  if (!wasFailed) await notifyOperator(deps, row, 'failed', reason);
}

/** A payment that went through was reversed: the invoice is open again. */
export async function markCollectionDisputed(deps: CollectDeps, row: CollectRow): Promise<void> {
  if (row.collect_state === 'disputed') return;
  await patch(deps, row.id, {
    collect_state: 'disputed',
    collect_next_attempt_at: null,
    // only a payment Stripe reported is taken back — never one marked by hand
    ...(row.payment_status === 'paid'
      ? { payment_status: 'open', paid_at: null, paid_via: null, paid_note: null }
      : {}),
  });
  deps.logger.info({ invoiceId: row.id }, 'invoice payment disputed');
  await notifyOperator(deps, row, 'disputed', null);
}

/** Does this PaymentIntent belong to this invoice? Never trust the pairing blindly. */
function belongsTo(row: CollectRow, intent: StripePaymentIntent): boolean {
  return (
    intent.metadata?.[STRIPE_INVOICE_METADATA_KEY] === row.id &&
    intent.amount === row.gross_cents &&
    intent.currency.toLowerCase() === 'eur'
  );
}

/**
 * Brings the invoice in line with what Stripe says about its PaymentIntent NOW.
 * Used after creating the intent, for every event about it, and by the daily
 * look at debits that are under way.
 */
export async function applyPaymentIntent(
  deps: CollectDeps,
  row: CollectRow,
  intent: StripePaymentIntent
): Promise<'paid' | 'processing' | 'failed' | 'ignored'> {
  if (!belongsTo(row, intent)) return 'ignored';
  // an older intent of this invoice (an earlier attempt) says nothing about the current one
  if (row.stripe_payment_intent_id && row.stripe_payment_intent_id !== intent.id) return 'ignored';
  const nowIso = new Date(nowOf(deps)).toISOString();

  if (intent.status === 'succeeded') {
    if (row.collect_state === 'succeeded' || row.collect_state === 'disputed') return 'paid';
    await patch(deps, row.id, {
      collect_state: 'succeeded',
      collected_at: nowIso,
      collect_error: null,
      collect_next_attempt_at: null,
      collect_started_at: null,
      stripe_payment_intent_id: intent.id,
      // a cancelled invoice stays void; the money that arrived is the operator's to refund
      ...(row.payment_status === 'open'
        ? { payment_status: 'paid', paid_at: nowIso, paid_via: 'stripe' }
        : {}),
    });
    deps.logger.info({ invoiceId: row.id }, 'invoice collected');
    return 'paid';
  }

  if (intent.status === 'processing') {
    await patch(deps, row.id, {
      collect_state: 'processing',
      stripe_payment_intent_id: intent.id,
      collect_error: null,
      collect_started_at: null,
      collect_next_attempt_at: new Date(nowOf(deps) + INVOICE_COLLECT_RECHECK_MS).toISOString(),
    });
    return 'processing';
  }

  // requires_payment_method (declined / debit returned), requires_action (the
  // customer would have to approve — nobody is there), canceled
  const reason =
    intent.last_payment_error?.code ??
    (intent.status === 'canceled'
      ? 'payment_intent_canceled'
      : intent.status === 'requires_action'
        ? 'authentication_required'
        : 'payment_failed');
  if (row.collect_state === 'succeeded' || row.collect_state === 'disputed') return 'ignored';
  await markCollectionFailed(deps, row, reason, intent.id);
  return 'failed';
}

/**
 * One attempt to move the collection of an invoice forward. A no-op when
 * nothing is due, and for an invoice of the other Stripe mode.
 */
export async function processInvoiceCollection(deps: CollectDeps, invoiceId: string): Promise<void> {
  const { supabase, stripe, logger } = deps;
  const nowMs = nowOf(deps);
  const row = await loadCollectRow(supabase, { id: invoiceId });
  if (!row || row.collect_livemode !== stripe.livemode) return;
  if (!isInvoiceCollectionDue(row, nowMs)) return;

  // --- a debit that is under way: ask Stripe how it stands ---------------------------
  if (row.collect_state === 'processing') {
    if (!row.stripe_payment_intent_id) return;
    const intent = await retrievePaymentIntent(stripe.config, row.stripe_payment_intent_id);
    if (!intent) {
      await markCollectionFailed(deps, row, 'payment_failed');
      return;
    }
    await applyPaymentIntent(deps, row, intent);
    return;
  }

  // --- a charge that is due ----------------------------------------------------------
  if (
    row.kind !== 'invoice' ||
    row.payment_status !== 'open' ||
    row.cancelled_by_invoice_id !== null ||
    row.payment_method === 'transfer'
  ) {
    // paid by hand or cancelled meanwhile: nothing is charged
    await patch(deps, row.id, { collect_state: 'none', collect_next_attempt_at: null });
    return;
  }
  if (!row.org_id) {
    await markCollectionFailed(deps, row, 'not_enabled');
    return;
  }
  const { data: customerData, error: customerError } = await supabase
    .from('billing_stripe_customers')
    .select('enabled, stripe_customer_id, payment_method_id, payment_method_type')
    .eq('org_id', row.org_id)
    .eq('livemode', stripe.livemode)
    .maybeSingle();
  if (customerError) throw customerError;
  const customer = customerData as {
    enabled: boolean;
    stripe_customer_id: string | null;
    payment_method_id: string | null;
    payment_method_type: string | null;
  } | null;
  if (!customer?.enabled || !customer.stripe_customer_id) {
    await markCollectionFailed(deps, row, 'not_enabled');
    return;
  }
  const type = customer.payment_method_type;
  if (!customer.payment_method_id || (type !== 'sepa_debit' && type !== 'card')) {
    await markCollectionFailed(deps, row, 'no_payment_method');
    return;
  }

  // Take the row: whoever gets it charges. A second job finds it leased.
  const beganEarlier = row.collect_started_at !== null;
  const { data: taken, error: takeError } = await supabase
    .from('billing_invoices')
    .update({
      collect_started_at: row.collect_started_at ?? new Date(nowMs).toISOString(),
      collect_next_attempt_at: new Date(nowMs + INVOICE_COLLECT_LEASE_MS).toISOString(),
    })
    .eq('id', row.id)
    .eq('collect_state', 'scheduled')
    .eq('payment_status', 'open')
    .select('id');
  if (takeError) throw takeError;
  if (!taken || taken.length === 0) return;

  try {
    let intent: StripePaymentIntent | null = null;
    if (beganEarlier) {
      // An earlier run began this attempt and did not come back with a result.
      // Its idempotency key may have expired — look whether the charge exists.
      const existing = await listCustomerPaymentIntents(stripe.config, customer.stripe_customer_id);
      intent =
        existing.find(
          (candidate) =>
            belongsTo(row, candidate) &&
            candidate.metadata?.zendori_collect_attempt === String(row.collect_attempts)
        ) ?? null;
    }
    intent ??= await createInvoicePaymentIntent(stripe.config, {
      invoiceId: row.id,
      invoiceNumber: row.number,
      orgId: row.org_id,
      customerId: customer.stripe_customer_id,
      paymentMethodId: customer.payment_method_id,
      paymentMethodType: type,
      amountCents: row.gross_cents,
      attempt: row.collect_attempts,
    });
    await applyPaymentIntent(deps, { ...row, stripe_payment_intent_id: null }, intent);
  } catch (err) {
    if (err instanceof StripeApiError && !isStripeRetryable(err)) {
      // Stripe refused the charge (declined card, missing mandate, amount too small, …)
      await markCollectionFailed(deps, row, err.code ?? 'payment_failed');
      return;
    }
    // an outage: the same attempt again later — the idempotency key and the
    // look-up above make sure it cannot charge twice
    await patch(deps, row.id, {
      collect_next_attempt_at: new Date(nowMs + INVOICE_COLLECT_OUTAGE_RETRY_MS).toISOString(),
    });
    logger.warn({ invoiceId: row.id, err: toErrorInfo(err) }, 'invoice collection postponed');
  }
}

/** The PaymentIntent a dispute or an event points at, applied to its invoice. */
export async function applyPaymentIntentById(
  deps: CollectDeps,
  paymentIntentId: string
): Promise<'paid' | 'processing' | 'failed' | 'ignored' | 'unknown'> {
  const intent = await retrievePaymentIntent(deps.stripe.config, paymentIntentId);
  const invoiceId = intent?.metadata?.[STRIPE_INVOICE_METADATA_KEY];
  if (!intent || !invoiceId) return 'unknown';
  const row = await loadCollectRow(deps.supabase, { id: invoiceId });
  if (!row || row.collect_livemode !== deps.stripe.livemode) return 'unknown';
  // the customer of the intent must be the customer of the invoice
  if (row.org_id) {
    const { data } = await deps.supabase
      .from('billing_stripe_customers')
      .select('stripe_customer_id')
      .eq('org_id', row.org_id)
      .eq('livemode', deps.stripe.livemode)
      .maybeSingle();
    const customerId = (data as { stripe_customer_id: string | null } | null)?.stripe_customer_id;
    if (!customerId || stripeRefId(intent.customer) !== customerId) return 'unknown';
  }
  return applyPaymentIntent(deps, row, intent);
}
