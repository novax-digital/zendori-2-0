import { describe, expect, it } from 'vitest';
import { createLogger } from '@zendori/core';
import { StripeApiError } from '@zendori/integrations';
import {
  BILLING_SYNC_RETRY_DELAYS_MS,
  isBillingSyncDue,
  syncBillingCustomer,
} from '../src/billing/customer-sync.js';
import {
  STRIPE_EVENT_RETENTION_MS,
  STRIPE_EVENT_RETRY_DELAYS_MS,
  processStripeEvent,
  pruneStripeEvents,
} from '../src/billing/stripe-events.js';
import type { BillingDeps } from '../src/billing/stripe.js';
import { createFakeStripe, type FakeStripe } from './fake-stripe.js';
import { createMemoryDb, type MemoryDb } from './memory-supabase.js';

// Phase 15a: the worker side of Stripe billing. Pins that a customer is created
// once, that the stored state always comes from a fresh read of Stripe, that an
// event can arrive twice / out of order / for somebody else without harm, and
// that test and live never touch each other's rows.

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-25T10:00:00Z');
const logger = createLogger('test', 'silent');
const iso = (ms: number) => new Date(ms).toISOString();

const DETAILS = {
  org_id: ORG,
  legal_name: 'Muster GmbH',
  address_line1: 'Hauptstraße 1',
  address_line2: null,
  postal_code: '1010',
  city: 'Wien',
  country: 'AT',
  vat_id: 'ATU12345678',
  billing_email: 'rechnung@example.com',
};

function customerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    org_id: ORG,
    livemode: false,
    enabled: true,
    invoice_from: '2026-11',
    stripe_account_id: null,
    stripe_customer_id: null,
    customer_generation: 0,
    payment_method_id: null,
    payment_method_type: null,
    payment_method_label: null,
    vat_id_value: null,
    vat_id_status: null,
    sync_requested_at: iso(NOW - 5_000),
    sync_attempts: 0,
    sync_next_attempt_at: null,
    sync_error: null,
    synced_at: null,
    ...overrides,
  };
}

interface World {
  db: MemoryDb;
  stripe: FakeStripe;
  deps: BillingDeps;
  clock: { now: number };
  row(livemode?: boolean): Record<string, unknown>;
}

function world(
  options: {
    rows?: Record<string, unknown>[];
    details?: Record<string, unknown> | null;
    events?: Record<string, unknown>[];
    livemode?: boolean;
    accountId?: string;
  } = {}
): World {
  const stripe = createFakeStripe(options.accountId);
  const db = createMemoryDb({
    billing_stripe_customers: options.rows ?? [customerRow()],
    billing_accounts: options.details === null ? [] : [options.details ?? DETAILS],
    stripe_events: options.events ?? [],
  });
  const clock = { now: NOW };
  const livemode = options.livemode ?? false;
  return {
    db,
    stripe,
    clock,
    deps: {
      supabase: db.client,
      logger,
      stripe: { config: stripe.config, livemode },
      now: () => clock.now,
      accountId: async () => stripe.accountId,
    },
    row: (mode = livemode) =>
      db.rows('billing_stripe_customers').find((r) => r.org_id === ORG && r.livemode === mode)!,
  };
}

/** A customer that already exists at Stripe and in the row. */
function withCustomer(w: World, overrides: Record<string, unknown> = {}): string {
  const id = 'cus_existing';
  w.stripe.customers.set(id, {
    id,
    object: 'customer',
    tax_exempt: 'none',
    invoice_settings: { default_payment_method: null },
  });
  Object.assign(w.row(), {
    stripe_customer_id: id,
    stripe_account_id: w.stripe.accountId,
    sync_requested_at: null,
    ...overrides,
  });
  return id;
}

function addPaymentMethod(
  w: World,
  customerId: string,
  id: string,
  kind: 'sepa' | 'card' = 'sepa'
): void {
  w.stripe.paymentMethods.set(
    id,
    kind === 'sepa'
      ? { id, type: 'sepa_debit', customer: customerId, sepa_debit: { last4: '3000' } }
      : { id, type: 'card', customer: customerId, card: { brand: 'visa', last4: '4242' } }
  );
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'evt_1',
    type: 'customer.updated',
    livemode: false,
    object_type: 'customer',
    object_id: 'cus_existing',
    customer_id: 'cus_existing',
    state: 'pending',
    attempts: 0,
    next_attempt_at: iso(NOW - 1_000),
    last_error: null,
    created_at: iso(NOW - 2_000),
    processed_at: null,
    ...overrides,
  };
}

const eventRow = (w: World, id = 'evt_1') =>
  w.db.rows('stripe_events').find((r) => r.event_id === id)!;

describe('syncBillingCustomer', () => {
  it('creates the customer once, pushes the details and copies the state back', async () => {
    const w = world();
    await syncBillingCustomer(w.deps, ORG);

    const row = w.row();
    expect(w.stripe.customers.size).toBe(1);
    const customer = [...w.stripe.customers.values()][0]!;
    expect(row.stripe_customer_id).toBe(customer.id);
    expect(row.stripe_account_id).toBe('acct_test');
    expect(customer.name).toBe('Muster GmbH');
    expect(customer.email).toBe('rechnung@example.com');
    // an EU business outside Germany: reverse charge on the customer
    expect(customer.tax_exempt).toBe('reverse');
    expect(w.stripe.taxIds.get(customer.id as string)).toHaveLength(1);
    expect(row.vat_id_value).toBe('ATU12345678');
    expect(row.vat_id_status).toBe('pending');
    expect(row.sync_requested_at).toBeNull();
    expect(row.sync_error).toBeNull();
    expect(row.synced_at).toBe(iso(NOW));

    const create = w.stripe.calls.find((c) => c.method === 'POST' && c.path === '/v1/customers')!;
    expect(create.idempotencyKey).toBe(`zcus:${ORG}:0`);
    // the creating request carries nothing but the org id
    expect([...create.params.keys()]).toEqual(['metadata[zendori_org_id]']);
  });

  it('does nothing when no sync is requested', async () => {
    const w = world({ rows: [customerRow({ sync_requested_at: null })] });
    await syncBillingCustomer(w.deps, ORG);
    expect(w.stripe.calls).toHaveLength(0);
  });

  it('creates the customer even while the details are incomplete', async () => {
    const w = world({ details: { ...DETAILS, city: null } });
    await syncBillingCustomer(w.deps, ORG);
    const customer = [...w.stripe.customers.values()][0]!;
    expect(w.row().stripe_customer_id).toBe(customer.id);
    expect(customer.name).toBeUndefined();
    expect(w.row().sync_requested_at).toBeNull();
  });

  it('keeps a German customer taxable and without a VAT id entry', async () => {
    const w = world({ details: { ...DETAILS, country: 'DE', vat_id: null, postal_code: '10115' } });
    await syncBillingCustomer(w.deps, ORG);
    const customer = [...w.stripe.customers.values()][0]!;
    expect(customer.tax_exempt).toBe('none');
    expect(w.stripe.taxIds.get(customer.id as string) ?? []).toHaveLength(0);
    expect(w.row().vat_id_value).toBeNull();
    expect(w.row().vat_id_status).toBeNull();
  });

  it('retries a Stripe outage on the schedule in the row, then succeeds', async () => {
    const w = world();
    w.stripe.failNext((c) => c.path === '/v1/customers' && c.method === 'POST', 500);
    await syncBillingCustomer(w.deps, ORG);
    let row = w.row();
    expect(row.sync_attempts).toBe(1);
    expect(row.sync_error).toBe('stripe:500');
    expect(row.sync_requested_at).not.toBeNull();
    expect(row.sync_next_attempt_at).toBe(iso(NOW + BILLING_SYNC_RETRY_DELAYS_MS[0]!));
    expect(isBillingSyncDue(row as never, w.clock.now)).toBe(false);

    // not due yet: no request
    const before = w.stripe.calls.length;
    await syncBillingCustomer(w.deps, ORG);
    expect(w.stripe.calls).toHaveLength(before);

    w.clock.now = NOW + BILLING_SYNC_RETRY_DELAYS_MS[0]! + 1;
    await syncBillingCustomer(w.deps, ORG);
    row = w.row();
    expect(row.sync_requested_at).toBeNull();
    expect(row.sync_attempts).toBe(0);
    expect(row.sync_error).toBeNull();
    expect(row.sync_next_attempt_at).toBeNull();
    // the failed attempt left no second customer behind
    expect(w.stripe.customers.size).toBe(1);
  });

  it('gives up at once on a request Stripe rejects', async () => {
    const w = world();
    w.stripe.failNext(
      (c) => c.path === '/v1/customers' && c.method === 'POST',
      401,
      'api_key_expired'
    );
    await syncBillingCustomer(w.deps, ORG);
    const row = w.row();
    expect(row.sync_requested_at).toBeNull();
    expect(row.sync_error).toBe('stripe:401:api_key_expired');
    expect(row.stripe_customer_id).toBeNull();
  });

  it('drops the request after the last retry', async () => {
    const w = world({
      rows: [customerRow({ sync_attempts: BILLING_SYNC_RETRY_DELAYS_MS.length })],
    });
    w.stripe.failNext((c) => c.path === '/v1/customers', 503);
    await syncBillingCustomer(w.deps, ORG);
    expect(w.row().sync_requested_at).toBeNull();
    expect(w.row().sync_error).toBe('stripe:503');
  });

  it('creates a new customer under a new key when the old one was deleted in Stripe', async () => {
    const w = world();
    const old = withCustomer(w, { sync_requested_at: iso(NOW - 1_000) });
    w.stripe.customers.set(old, { id: old, object: 'customer', deleted: true });

    await syncBillingCustomer(w.deps, ORG);
    const row = w.row();
    expect(row.stripe_customer_id).not.toBe(old);
    expect(row.customer_generation).toBe(1);
    const create = w.stripe.calls.find((c) => c.method === 'POST' && c.path === '/v1/customers')!;
    expect(create.idempotencyKey).toBe(`zcus:${ORG}:1`);
    expect(w.stripe.customers.get(row.stripe_customer_id as string)?.name).toBe('Muster GmbH');
    expect(row.sync_requested_at).toBeNull();
  });

  it('refuses a live key of another Stripe account', async () => {
    const w = world({ rows: [customerRow({ livemode: true })], livemode: true });
    const id = withCustomer(w, {
      stripe_account_id: 'acct_other',
      sync_requested_at: iso(NOW - 1_000),
    });
    await syncBillingCustomer(w.deps, ORG);
    const row = w.row(true);
    expect(row.stripe_customer_id).toBe(id);
    expect(row.sync_error).toBe('account_mismatch');
    expect(row.sync_requested_at).toBeNull();
    expect(w.stripe.writes()).toHaveLength(0);
  });

  it('starts over in a new sandbox (test key of another account)', async () => {
    const w = world();
    withCustomer(w, { stripe_account_id: 'acct_old_sandbox', sync_requested_at: iso(NOW - 1_000) });
    await syncBillingCustomer(w.deps, ORG);
    const row = w.row();
    expect(row.stripe_customer_id).not.toBe('cus_existing');
    expect(row.customer_generation).toBe(1);
    expect(row.sync_error).toBeNull();
  });

  it('works with a restricted key that may not read the account', async () => {
    const w = world();
    w.deps.accountId = async () => {
      throw new StripeApiError(403, 'GET', '/v1/account', { code: 'permission_denied' });
    };
    await syncBillingCustomer(w.deps, ORG);
    const row = w.row();
    expect(row.stripe_customer_id).not.toBeNull();
    expect(row.stripe_account_id).toBeNull();
    expect(row.sync_requested_at).toBeNull();
    expect(row.sync_error).toBeNull();
  });

  it('never touches the row of the other mode', async () => {
    const live = customerRow({
      livemode: true,
      stripe_customer_id: 'cus_live',
      sync_requested_at: iso(NOW - 1_000),
    });
    const w = world({ rows: [customerRow({ sync_requested_at: null }), live] });
    await syncBillingCustomer(w.deps, ORG); // worker runs on a test key
    expect(w.stripe.calls).toHaveLength(0);
    expect(w.row(true).stripe_customer_id).toBe('cus_live');
    expect(w.row(true).sync_requested_at).toBe(iso(NOW - 1_000));
  });

  it('keeps a request that arrived while the attempt was running', async () => {
    const w = world();
    const newer = iso(NOW + 500);
    // the web app saves new details while the worker is busy
    w.stripe.failNext(() => {
      w.row().sync_requested_at = newer;
      return false;
    }, 0);
    await syncBillingCustomer(w.deps, ORG);
    expect(w.row().sync_requested_at).toBe(newer);
    expect(w.row().sync_next_attempt_at).toBeNull();
    expect(isBillingSyncDue(w.row() as never, w.clock.now)).toBe(true);
  });

  it('copies the default payment method as kind and last four digits only', async () => {
    const w = world();
    const id = withCustomer(w, { sync_requested_at: iso(NOW - 1_000) });
    addPaymentMethod(w, id, 'pm_card', 'card');
    (
      w.stripe.customers.get(id)!.invoice_settings as Record<string, unknown>
    ).default_payment_method = 'pm_card';
    await syncBillingCustomer(w.deps, ORG);
    const row = w.row();
    expect(row.payment_method_id).toBe('pm_card');
    expect(row.payment_method_type).toBe('card');
    expect(row.payment_method_label).toBe('Visa •••• 4242');
  });
});

describe('processStripeEvent', () => {
  function checkoutWorld(): { w: World; customerId: string } {
    const w = world({
      events: [
        event({
          type: 'checkout.session.completed',
          object_type: 'checkout.session',
          object_id: 'cs_1',
        }),
      ],
    });
    const customerId = withCustomer(w);
    addPaymentMethod(w, customerId, 'pm_sepa');
    w.stripe.setupIntents.set('seti_1', {
      id: 'seti_1',
      status: 'succeeded',
      customer: customerId,
      payment_method: 'pm_sepa',
    });
    w.stripe.sessions.set('cs_1', {
      id: 'cs_1',
      mode: 'setup',
      status: 'complete',
      customer: customerId,
      setup_intent: 'seti_1',
    });
    return { w, customerId };
  }

  it('makes the stored method the default and copies it into the row', async () => {
    const { w, customerId } = checkoutWorld();
    await processStripeEvent(w.deps, 'evt_1');

    const settings = w.stripe.customers.get(customerId)!.invoice_settings as Record<
      string,
      unknown
    >;
    expect(settings.default_payment_method).toBe('pm_sepa');
    const row = w.row();
    expect(row.payment_method_id).toBe('pm_sepa');
    expect(row.payment_method_type).toBe('sepa_debit');
    expect(row.payment_method_label).toBe('SEPA-Lastschrift •••• 3000');
    expect(eventRow(w)).toMatchObject({
      state: 'done',
      attempts: 1,
      last_error: null,
      processed_at: iso(NOW),
    });
  });

  it('handles the same event only once', async () => {
    const { w } = checkoutWorld();
    await processStripeEvent(w.deps, 'evt_1');
    const calls = w.stripe.calls.length;
    await processStripeEvent(w.deps, 'evt_1');
    await processStripeEvent(w.deps, 'evt_1');
    expect(w.stripe.calls).toHaveLength(calls);
    expect(w.stripe.writes()).toHaveLength(1);
  });

  it('ends in the same state when a second event reports the same setup', async () => {
    const { w } = checkoutWorld();
    w.db.rows('stripe_events').push(
      event({
        event_id: 'evt_2',
        type: 'setup_intent.succeeded',
        object_type: 'setup_intent',
        object_id: 'seti_1',
      })
    );
    // delivered in the "wrong" order
    await processStripeEvent(w.deps, 'evt_2');
    await processStripeEvent(w.deps, 'evt_1');
    expect(w.row().payment_method_id).toBe('pm_sepa');
    expect(eventRow(w, 'evt_1').state).toBe('done');
    expect(eventRow(w, 'evt_2').state).toBe('done');
  });

  it('waits for setup_intent.succeeded when the setup is not finished yet', async () => {
    const { w, customerId } = checkoutWorld();
    w.stripe.setupIntents.get('seti_1')!.status = 'processing';
    await processStripeEvent(w.deps, 'evt_1');
    expect(eventRow(w)).toMatchObject({ state: 'skipped', last_error: 'setup_not_succeeded' });
    expect(w.stripe.writes()).toHaveLength(0);
    const settings = w.stripe.customers.get(customerId)!.invoice_settings as Record<
      string,
      unknown
    >;
    expect(settings.default_payment_method).toBeNull();
  });

  it('retries after a failure and then succeeds', async () => {
    const { w } = checkoutWorld();
    w.stripe.failNext((c) => c.path === '/v1/checkout/sessions/cs_1', 500);
    await processStripeEvent(w.deps, 'evt_1');
    expect(eventRow(w)).toMatchObject({
      state: 'pending',
      attempts: 1,
      last_error: 'stripe:500',
      next_attempt_at: iso(NOW + STRIPE_EVENT_RETRY_DELAYS_MS[0]!),
    });
    expect(w.row().payment_method_id).toBeNull();

    // not due: nothing happens
    await processStripeEvent(w.deps, 'evt_1');
    expect(eventRow(w).attempts).toBe(1);

    w.clock.now = NOW + STRIPE_EVENT_RETRY_DELAYS_MS[0]! + 1;
    await processStripeEvent(w.deps, 'evt_1');
    expect(eventRow(w).state).toBe('done');
    expect(w.row().payment_method_id).toBe('pm_sepa');
  });

  it('fails at once on a request Stripe rejects, and after the last retry', async () => {
    const rejected = checkoutWorld().w;
    rejected.stripe.failNext(
      (c) => c.path === '/v1/checkout/sessions/cs_1',
      403,
      'permission_denied'
    );
    await processStripeEvent(rejected.deps, 'evt_1');
    expect(eventRow(rejected)).toMatchObject({
      state: 'failed',
      last_error: 'stripe:403:permission_denied',
    });

    const exhausted = checkoutWorld().w;
    eventRow(exhausted).attempts = STRIPE_EVENT_RETRY_DELAYS_MS.length;
    exhausted.stripe.failNext((c) => c.path === '/v1/checkout/sessions/cs_1', 503);
    await processStripeEvent(exhausted.deps, 'evt_1');
    expect(eventRow(exhausted)).toMatchObject({ state: 'failed', last_error: 'stripe:503' });
  });

  it('skips an event of the other mode without asking Stripe', async () => {
    const w = world({ events: [event({ livemode: true })] });
    withCustomer(w);
    await processStripeEvent(w.deps, 'evt_1');
    expect(eventRow(w)).toMatchObject({ state: 'skipped', last_error: 'other_mode' });
    expect(w.stripe.calls).toHaveLength(0);
  });

  it('skips a session of a customer that is not ours', async () => {
    const { w } = checkoutWorld();
    w.stripe.sessions.get('cs_1')!.customer = 'cus_somebody_else';
    await processStripeEvent(w.deps, 'evt_1');
    expect(eventRow(w)).toMatchObject({ state: 'skipped', last_error: 'unknown_customer' });
    expect(w.stripe.writes()).toHaveLength(0);
    expect(w.row().payment_method_id).toBeNull();
  });

  it('never pairs our customer with a setup of another customer', async () => {
    const { w } = checkoutWorld();
    w.stripe.setupIntents.get('seti_1')!.customer = 'cus_somebody_else';
    await processStripeEvent(w.deps, 'evt_1');
    expect(eventRow(w)).toMatchObject({ state: 'skipped', last_error: 'foreign_customer' });
    expect(w.stripe.writes()).toHaveLength(0);
  });

  it('ignores a payment-mode session', async () => {
    const { w } = checkoutWorld();
    w.stripe.sessions.get('cs_1')!.mode = 'payment';
    await processStripeEvent(w.deps, 'evt_1');
    expect(eventRow(w)).toMatchObject({ state: 'skipped', last_error: 'not_setup' });
  });

  it('copies the VAT id check — but only for the VAT id on file', async () => {
    const w = world({
      events: [
        event({ type: 'customer.tax_id.updated', object_type: 'tax_id', object_id: 'txi_1' }),
      ],
    });
    const id = withCustomer(w);
    w.stripe.taxIds.set(id, [
      { id: 'txi_0', type: 'eu_vat', value: 'ATU00000000', verification: { status: 'verified' } },
      { id: 'txi_1', type: 'eu_vat', value: 'ATU12345678', verification: { status: 'unverified' } },
    ]);
    await processStripeEvent(w.deps, 'evt_1');
    expect(w.row().vat_id_value).toBe('ATU12345678');
    expect(w.row().vat_id_status).toBe('unverified');

    // the VAT id on file has no entry at Stripe: an old check must not count
    const stale = world({ events: [event({ type: 'customer.tax_id.updated' })] });
    const staleId = withCustomer(stale, { vat_id_value: 'ATU12345678', vat_id_status: 'verified' });
    stale.stripe.taxIds.set(staleId, [
      { id: 'txi_0', type: 'eu_vat', value: 'ATU00000000', verification: { status: 'verified' } },
    ]);
    await processStripeEvent(stale.deps, 'evt_1');
    expect(stale.row().vat_id_value).toBeNull();
    expect(stale.row().vat_id_status).toBeNull();
  });

  it('clears the row when the payment method is detached', async () => {
    const w = world({
      events: [
        event({
          type: 'payment_method.detached',
          object_type: 'payment_method',
          object_id: 'pm_sepa',
          customer_id: null,
        }),
      ],
    });
    withCustomer(w, {
      payment_method_id: 'pm_sepa',
      payment_method_type: 'sepa_debit',
      payment_method_label: 'SEPA-Lastschrift •••• 3000',
    });
    await processStripeEvent(w.deps, 'evt_1');
    expect(w.row()).toMatchObject({
      payment_method_id: null,
      payment_method_type: null,
      payment_method_label: null,
    });
    expect(eventRow(w).state).toBe('done');
  });

  it('finds the customer of a mandate through its payment method', async () => {
    const w = world({
      events: [
        event({
          type: 'mandate.updated',
          object_type: 'mandate',
          object_id: 'mandate_1',
          customer_id: null,
        }),
      ],
    });
    const id = withCustomer(w, { payment_method_id: 'pm_sepa' });
    addPaymentMethod(w, id, 'pm_sepa');
    w.stripe.mandates.set('mandate_1', {
      id: 'mandate_1',
      status: 'inactive',
      payment_method: 'pm_sepa',
    });
    await processStripeEvent(w.deps, 'evt_1');
    expect(eventRow(w).state).toBe('done');
    // the customer has no default method (any more): the row says so
    expect(w.row().payment_method_id).toBeNull();
  });

  it('forgets a customer that was deleted in Stripe', async () => {
    const w = world({ events: [event({ type: 'customer.deleted' })] });
    const id = withCustomer(w, {
      payment_method_id: 'pm_sepa',
      payment_method_label: 'SEPA-Lastschrift •••• 3000',
    });
    w.stripe.customers.set(id, { id, object: 'customer', deleted: true });
    await processStripeEvent(w.deps, 'evt_1');
    expect(w.row()).toMatchObject({
      stripe_customer_id: null,
      customer_generation: 1,
      payment_method_id: null,
      payment_method_label: null,
    });
    expect(eventRow(w).state).toBe('done');
  });

  it('skips an event about an unknown customer', async () => {
    const w = world({ events: [event({ customer_id: 'cus_unknown', object_id: 'cus_unknown' })] });
    withCustomer(w);
    await processStripeEvent(w.deps, 'evt_1');
    expect(eventRow(w)).toMatchObject({ state: 'skipped', last_error: 'unknown_customer' });
    expect(w.stripe.calls).toHaveLength(0);
  });

  it('never mixes up two organizations', async () => {
    const w = world({
      rows: [
        customerRow({ sync_requested_at: null }),
        customerRow({
          org_id: OTHER_ORG,
          stripe_customer_id: 'cus_other',
          sync_requested_at: null,
        }),
      ],
      events: [event()],
    });
    const id = withCustomer(w);
    addPaymentMethod(w, id, 'pm_card', 'card');
    (
      w.stripe.customers.get(id)!.invoice_settings as Record<string, unknown>
    ).default_payment_method = 'pm_card';
    await processStripeEvent(w.deps, 'evt_1');
    const other = w.db.rows('billing_stripe_customers').find((r) => r.org_id === OTHER_ORG)!;
    expect(other.payment_method_id).toBeNull();
    expect(w.row().payment_method_id).toBe('pm_card');
  });

  it('prunes old events only', async () => {
    const db = createMemoryDb({
      stripe_events: [
        event({ event_id: 'old', created_at: iso(NOW - STRIPE_EVENT_RETENTION_MS - 1_000) }),
        event({ event_id: 'recent', created_at: iso(NOW - 1_000) }),
      ],
    });
    await pruneStripeEvents(db.client, NOW);
    expect(db.rows('stripe_events').map((r) => r.event_id)).toEqual(['recent']);
  });
});
