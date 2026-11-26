import { describe, expect, it } from 'vitest';
import { createLogger } from '@zendori/core';
import type { SendEmailParams } from '@zendori/channels';
import {
  INVOICE_COLLECT_OUTAGE_RETRY_MS,
  INVOICE_COLLECT_RECHECK_MS,
  applyPaymentIntentById,
  isInvoiceCollectionDue,
  loadCollectRow,
  markCollectionDisputed,
  processInvoiceCollection,
  type CollectDeps,
} from '../src/billing/invoice-collect.js';
import { createFakeStripe, type FakeStripe } from './fake-stripe.js';
import { createMemoryDb, type MemoryDb } from './memory-supabase.js';

// Phase 15b step 3: collecting an invoice through Stripe. Real money — so these
// tests pin above all what must NEVER happen: a charge before the announced
// day, a charge for a paid or cancelled invoice, and a second charge.

const ID = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-12-04T08:00:00Z');
const logger = createLogger('test', 'silent');
const iso = (ms: number): string => new Date(ms).toISOString();

function invoiceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    org_id: ORG,
    kind: 'invoice',
    number: 'ZD-2026-0001',
    gross_cents: 7238,
    payment_status: 'open',
    paid_at: null,
    paid_via: null,
    paid_note: null,
    cancelled_by_invoice_id: null,
    payment_method: 'sepa_debit',
    collect_on: '2026-12-04',
    collect_state: 'scheduled',
    collect_livemode: false,
    collect_attempts: 0,
    collect_started_at: null,
    collect_next_attempt_at: null,
    collect_error: null,
    collected_at: null,
    stripe_payment_intent_id: null,
    seller: { legalName: 'Novax Digital GmbH', email: 'buchhaltung@example.org' },
    recipient: { legalName: 'Muster GmbH' },
    ...overrides,
  };
}

function customerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    org_id: ORG,
    livemode: false,
    enabled: true,
    stripe_customer_id: 'cus_1',
    payment_method_id: 'pm_1',
    payment_method_type: 'sepa_debit',
    ...overrides,
  };
}

interface World {
  db: MemoryDb;
  stripe: FakeStripe;
  deps: CollectDeps;
  clock: { now: number };
  mails: SendEmailParams[];
  row(): Record<string, unknown>;
  charges(): ReturnType<FakeStripe['writes']>;
}

function world(
  options: {
    invoice?: Record<string, unknown>;
    customer?: Record<string, unknown> | null;
    livemode?: boolean;
  } = {}
): World {
  const stripe = createFakeStripe();
  const db = createMemoryDb({
    billing_invoices: [options.invoice ?? invoiceRow()],
    billing_stripe_customers: options.customer === null ? [] : [options.customer ?? customerRow()],
  });
  const clock = { now: NOW };
  const mails: SendEmailParams[] = [];
  return {
    db,
    stripe,
    clock,
    mails,
    deps: {
      supabase: db.client,
      logger,
      stripe: { config: stripe.config, livemode: options.livemode ?? false },
      from: 'Zendori <rechnung@example.org>',
      appUrl: 'https://app.example.com',
      now: () => clock.now,
      send: async (params) => {
        mails.push(params);
      },
    },
    row: () => db.rows('billing_invoices')[0]!,
    charges: () => stripe.writes().filter((call) => call.path === '/v1/payment_intents'),
  };
}

describe('processInvoiceCollection', () => {
  it('charges a SEPA debit on the announced day and waits for the bank', async () => {
    const w = world();
    await processInvoiceCollection(w.deps, ID);

    const [charge] = w.charges();
    expect(w.charges()).toHaveLength(1);
    expect(charge!.idempotencyKey).toBe(`zinv:${ID}:0`);
    expect(Object.fromEntries(charge!.params)).toMatchObject({
      amount: '7238',
      currency: 'eur',
      customer: 'cus_1',
      payment_method: 'pm_1',
      'payment_method_types[0]': 'sepa_debit',
      off_session: 'true',
      confirm: 'true',
      description: 'Rechnung ZD-2026-0001',
      'metadata[zendori_invoice_id]': ID,
      'metadata[zendori_collect_attempt]': '0',
    });
    // only ids and the invoice number leave for Stripe — no line items, no names
    expect([...charge!.params.keys()].some((key) => /line|recipient|seller/.test(key))).toBe(false);

    const intentId = [...w.stripe.paymentIntents.keys()][0]!;
    expect(w.row()).toMatchObject({
      collect_state: 'processing',
      stripe_payment_intent_id: intentId,
      payment_status: 'open',
      collect_next_attempt_at: iso(NOW + INVOICE_COLLECT_RECHECK_MS),
    });
    expect(w.mails).toHaveLength(0);
  });

  it('a card payment that goes through marks the invoice paid at once', async () => {
    const w = world({ customer: customerRow({ payment_method_type: 'card' }) });
    await processInvoiceCollection(w.deps, ID);
    expect(w.row()).toMatchObject({
      collect_state: 'succeeded',
      payment_status: 'paid',
      paid_via: 'stripe',
      paid_at: iso(NOW),
      collected_at: iso(NOW),
    });
  });

  it('never charges before the day the invoice announced', async () => {
    const w = world({ invoice: invoiceRow({ collect_on: '2026-12-05' }) });
    await processInvoiceCollection(w.deps, ID);
    expect(w.stripe.calls).toHaveLength(0);
    expect(w.row().collect_state).toBe('scheduled');
    // 23:30 UTC on the 4th is already the 5th in Germany
    w.clock.now = Date.parse('2026-12-04T23:30:00Z');
    await processInvoiceCollection(w.deps, ID);
    expect(w.charges()).toHaveLength(1);
  });

  it('never charges an invoice that was paid by hand or cancelled meanwhile', async () => {
    const paid = world({ invoice: invoiceRow({ payment_status: 'paid', paid_via: 'manual' }) });
    await processInvoiceCollection(paid.deps, ID);
    expect(paid.stripe.calls).toHaveLength(0);
    expect(paid.row().collect_state).toBe('none');

    const cancelled = world({
      invoice: invoiceRow({ payment_status: 'void', cancelled_by_invoice_id: 'x' }),
    });
    await processInvoiceCollection(cancelled.deps, ID);
    expect(cancelled.stripe.calls).toHaveLength(0);
    expect(cancelled.row().collect_state).toBe('none');
  });

  it('never touches an invoice of the other Stripe mode', async () => {
    const w = world({ livemode: true });
    await processInvoiceCollection(w.deps, ID);
    expect(w.stripe.calls).toHaveLength(0);
    expect(w.row().collect_state).toBe('scheduled');
  });

  it('fails without charging when Stripe billing is off or no payment method is on file', async () => {
    const off = world({ customer: customerRow({ enabled: false }) });
    await processInvoiceCollection(off.deps, ID);
    expect(off.stripe.calls).toHaveLength(0);
    expect(off.row()).toMatchObject({ collect_state: 'failed', collect_error: 'not_enabled' });

    const none = world({ customer: customerRow({ payment_method_id: null }) });
    await processInvoiceCollection(none.deps, ID);
    expect(none.row()).toMatchObject({ collect_state: 'failed', collect_error: 'no_payment_method' });
    expect(none.row().payment_status).toBe('open');
  });

  it('a declined card leaves the invoice open and tells the operator once', async () => {
    const w = world({ customer: customerRow({ payment_method_type: 'card' }) });
    w.stripe.nextCharge = { decline: 'card_declined' };
    await processInvoiceCollection(w.deps, ID);
    expect(w.row()).toMatchObject({
      collect_state: 'failed',
      collect_error: 'card_declined',
      payment_status: 'open',
      collect_next_attempt_at: null,
    });
    expect(w.mails).toHaveLength(1);
    expect(w.mails[0]!.to).toBe('buchhaltung@example.org');
    expect(w.mails[0]!.subject).toBe(
      '[Testmodus] Einzug fehlgeschlagen: Rechnung ZD-2026-0001 (Muster GmbH)'
    );
    expect(w.mails[0]!.text).toContain('Karte abgelehnt');
    // no automatic second attempt
    w.clock.now += 48 * 60 * 60_000;
    await processInvoiceCollection(w.deps, ID);
    expect(w.charges()).toHaveLength(1);
    expect(w.mails).toHaveLength(1);
  });

  it('after a Stripe outage it tries the SAME charge again — one payment, not two', async () => {
    const w = world();
    w.stripe.failNext((call) => call.path === '/v1/payment_intents' && call.method === 'POST', 503);
    await processInvoiceCollection(w.deps, ID);
    expect(w.row()).toMatchObject({
      collect_state: 'scheduled',
      collect_next_attempt_at: iso(NOW + INVOICE_COLLECT_OUTAGE_RETRY_MS),
    });
    expect(w.stripe.paymentIntents.size).toBe(0);

    w.clock.now = NOW + INVOICE_COLLECT_OUTAGE_RETRY_MS;
    await processInvoiceCollection(w.deps, ID);
    expect(w.stripe.paymentIntents.size).toBe(1);
    // both requests carried the same key: had the first one reached Stripe after
    // all, the second would have returned that payment instead of a new one
    expect(w.charges().map((call) => call.idempotencyKey)).toEqual([`zinv:${ID}:0`, `zinv:${ID}:0`]);
    // and before repeating it, the worker looked whether the charge already exists
    expect(
      w.stripe.calls.some((call) => call.method === 'GET' && call.path === '/v1/payment_intents')
    ).toBe(true);
    expect(w.row().collect_state).toBe('processing');
  });

  it('finds a charge an earlier run created but did not record — and does not charge again', async () => {
    // the earlier run reached Stripe, then died before writing the result
    const w = world({ invoice: invoiceRow({ collect_started_at: iso(NOW - 3 * 24 * 60 * 60_000) }) });
    w.stripe.paymentIntents.set('pi_lost', {
      id: 'pi_lost',
      object: 'payment_intent',
      amount: 7238,
      currency: 'eur',
      customer: 'cus_1',
      status: 'succeeded',
      metadata: { zendori_invoice_id: ID, zendori_collect_attempt: '0' },
    });
    await processInvoiceCollection(w.deps, ID);
    expect(w.charges()).toHaveLength(0);
    expect(w.row()).toMatchObject({
      collect_state: 'succeeded',
      payment_status: 'paid',
      stripe_payment_intent_id: 'pi_lost',
    });
  });

  it('looks after a debit that is under way once a day until the bank has answered', async () => {
    const w = world();
    await processInvoiceCollection(w.deps, ID);
    const intentId = String(w.row().stripe_payment_intent_id);

    // not due yet
    await processInvoiceCollection(w.deps, ID);
    expect(w.stripe.calls.filter((call) => call.method === 'GET')).toHaveLength(0);

    w.clock.now = NOW + INVOICE_COLLECT_RECHECK_MS;
    await processInvoiceCollection(w.deps, ID);
    expect(w.row().collect_state).toBe('processing');

    w.stripe.paymentIntents.get(intentId)!.status = 'succeeded';
    w.clock.now += INVOICE_COLLECT_RECHECK_MS;
    await processInvoiceCollection(w.deps, ID);
    expect(w.row()).toMatchObject({ collect_state: 'succeeded', payment_status: 'paid' });
    expect(w.charges()).toHaveLength(1);
  });

  it('a new attempt after a failure is a new charge with a new key', async () => {
    // the operator asked again: state back to scheduled, attempt counted up
    const w = world({
      invoice: invoiceRow({ collect_attempts: 1 }),
      customer: customerRow({ payment_method_type: 'card' }),
    });
    await processInvoiceCollection(w.deps, ID);
    expect(w.charges()[0]!.idempotencyKey).toBe(`zinv:${ID}:1`);
    expect(w.charges()[0]!.params.get('metadata[zendori_collect_attempt]')).toBe('1');
    expect(w.row().payment_status).toBe('paid');
  });
});

describe('what Stripe reports later', () => {
  async function charged(w: World): Promise<string> {
    await processInvoiceCollection(w.deps, ID);
    return String(w.row().stripe_payment_intent_id);
  }

  it('a debit that went through marks the invoice paid', async () => {
    const w = world();
    const intentId = await charged(w);
    w.stripe.paymentIntents.get(intentId)!.status = 'succeeded';
    expect(await applyPaymentIntentById(w.deps, intentId)).toBe('paid');
    expect(w.row()).toMatchObject({ collect_state: 'succeeded', payment_status: 'paid', paid_via: 'stripe' });
    // the same event again changes nothing
    const paidAt = w.row().paid_at;
    w.clock.now += 60_000;
    expect(await applyPaymentIntentById(w.deps, intentId)).toBe('paid');
    expect(w.row().paid_at).toBe(paidAt);
  });

  it('a returned debit leaves the invoice open and tells the operator', async () => {
    const w = world();
    const intentId = await charged(w);
    Object.assign(w.stripe.paymentIntents.get(intentId)!, {
      status: 'requires_payment_method',
      last_payment_error: { code: 'insufficient_funds' },
    });
    expect(await applyPaymentIntentById(w.deps, intentId)).toBe('failed');
    expect(w.row()).toMatchObject({
      collect_state: 'failed',
      collect_error: 'insufficient_funds',
      payment_status: 'open',
    });
    expect(w.mails).toHaveLength(1);
    expect(w.mails[0]!.text).toContain('Konto nicht gedeckt');
    // reported twice: one mail
    await applyPaymentIntentById(w.deps, intentId);
    expect(w.mails).toHaveLength(1);
  });

  it('a reversed payment puts the invoice back to open', async () => {
    const w = world({ customer: customerRow({ payment_method_type: 'card' }) });
    const intentId = await charged(w);
    expect(w.row().payment_status).toBe('paid');
    const row = (await loadCollectRow(w.deps.supabase, { paymentIntentId: intentId }))!;
    await markCollectionDisputed(w.deps, row);
    expect(w.row()).toMatchObject({
      collect_state: 'disputed',
      payment_status: 'open',
      paid_at: null,
      paid_via: null,
    });
    expect(w.mails[0]!.subject).toContain('Rückbuchung: Rechnung ZD-2026-0001');
    // a late "succeeded" for the same payment does not undo the reversal
    expect(await applyPaymentIntentById(w.deps, intentId)).toBe('paid');
    expect(w.row()).toMatchObject({ collect_state: 'disputed', payment_status: 'open' });
  });

  it('ignores a payment that is not one of our invoices or does not match it', async () => {
    const w = world();
    w.stripe.paymentIntents.set('pi_foreign', {
      id: 'pi_foreign',
      amount: 7238,
      currency: 'eur',
      customer: 'cus_1',
      status: 'succeeded',
      metadata: {},
    });
    expect(await applyPaymentIntentById(w.deps, 'pi_foreign')).toBe('unknown');
    expect(await applyPaymentIntentById(w.deps, 'pi_missing')).toBe('unknown');

    // names our invoice, but the amount is wrong
    w.stripe.paymentIntents.set('pi_wrong', {
      id: 'pi_wrong',
      amount: 1,
      currency: 'eur',
      customer: 'cus_1',
      status: 'succeeded',
      metadata: { zendori_invoice_id: ID },
    });
    expect(await applyPaymentIntentById(w.deps, 'pi_wrong')).toBe('ignored');
    // names our invoice, but belongs to another customer
    w.stripe.paymentIntents.set('pi_other', {
      id: 'pi_other',
      amount: 7238,
      currency: 'eur',
      customer: 'cus_other',
      status: 'succeeded',
      metadata: { zendori_invoice_id: ID },
    });
    expect(await applyPaymentIntentById(w.deps, 'pi_other')).toBe('unknown');
    expect(w.row()).toMatchObject({ collect_state: 'scheduled', payment_status: 'open' });
  });

  it('an old payment of an earlier attempt says nothing about the current one', async () => {
    const w = world({ customer: customerRow({ payment_method_type: 'card' }) });
    const current = await charged(w);
    w.stripe.paymentIntents.set('pi_old', {
      id: 'pi_old',
      amount: 7238,
      currency: 'eur',
      customer: 'cus_1',
      status: 'requires_payment_method',
      last_payment_error: { code: 'card_declined' },
      metadata: { zendori_invoice_id: ID },
    });
    expect(await applyPaymentIntentById(w.deps, 'pi_old')).toBe('ignored');
    expect(w.row()).toMatchObject({ collect_state: 'succeeded', stripe_payment_intent_id: current });
  });
});

describe('isInvoiceCollectionDue', () => {
  it('is due on the announced day, and for a running debit when its check comes up', () => {
    const base = { collect_on: '2026-12-04', collect_next_attempt_at: null };
    expect(isInvoiceCollectionDue({ ...base, collect_state: 'scheduled' }, NOW)).toBe(true);
    expect(
      isInvoiceCollectionDue({ ...base, collect_state: 'scheduled', collect_on: '2026-12-05' }, NOW)
    ).toBe(false);
    expect(isInvoiceCollectionDue({ ...base, collect_state: 'failed' }, NOW)).toBe(false);
    expect(isInvoiceCollectionDue({ ...base, collect_state: 'succeeded' }, NOW)).toBe(false);
    expect(
      isInvoiceCollectionDue(
        { ...base, collect_state: 'processing', collect_next_attempt_at: iso(NOW + 1) },
        NOW
      )
    ).toBe(false);
    expect(
      isInvoiceCollectionDue(
        { ...base, collect_state: 'processing', collect_next_attempt_at: iso(NOW) },
        NOW
      )
    ).toBe(true);
  });
});
