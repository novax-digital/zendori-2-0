import { describe, expect, it } from 'vitest';
import {
  STRIPE_API_VERSION,
  StripeApiError,
  StripeNetworkError,
  StripeSignatureError,
  createSetupCheckoutSession,
  createStripeCustomer,
  customerIdempotencyKey,
  encodeStripeForm,
  isStripeNotFound,
  isStripeRetryable,
  parseStripeWebhookSecrets,
  retrieveStripeCustomer,
  signStripePayload,
  stripeErrorCode,
  stripeEventRef,
  stripeEventSchema,
  stripeEventScope,
  stripeKeyLivemode,
  stripeRequest,
  syncCustomerVatId,
  updateStripeCustomer,
  verifyStripeSignature,
  type StripeConfig,
} from '../src/index.js';

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

type Reply = { status: number; body?: unknown } | { throws: 'network' };

/** A fetch that serves queued replies and records what it was asked. */
function fakeStripe(replies: Reply[]): {
  config: StripeConfig;
  calls: Recorded[];
  slept: number[];
} {
  const calls: Recorded[] = [];
  const slept: number[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies[index];
    index += 1;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    if (!reply) throw new Error(`unexpected Stripe call #${index}`);
    if ('throws' in reply) throw new TypeError('fetch failed');
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'request-id': `req_${index}` },
    });
  }) as unknown as typeof fetch;
  return {
    config: {
      secretKey: 'sk_test_abc123',
      fetchImpl,
      sleep: async (ms) => {
        slept.push(ms);
      },
    },
    calls,
    slept,
  };
}

describe('stripe key mode', () => {
  it('reads test and live from the key', () => {
    expect(stripeKeyLivemode('sk_test_abc123')).toBe(false);
    expect(stripeKeyLivemode('rk_test_abc123')).toBe(false);
    expect(stripeKeyLivemode('sk_live_abc123')).toBe(true);
    expect(stripeKeyLivemode('rk_live_abc123')).toBe(true);
  });

  it('rejects everything that is not a secret key', () => {
    for (const key of ['pk_live_abc', 'whsec_abc', 'sk_live_', 'live', '', 'sk_prod_abc']) {
      expect(stripeKeyLivemode(key)).toBeNull();
    }
  });
});

describe('encodeStripeForm', () => {
  it('encodes nested objects and arrays the way Stripe expects', () => {
    const encoded = encodeStripeForm({
      mode: 'setup',
      metadata: { zendori_org_id: 'org 1' },
      allowed_payment_method_types: ['sepa_debit', 'card'],
      address: { line1: 'Hauptstraße 1', line2: null },
      expand: ['invoice_settings.default_payment_method'],
      limit: 100,
      enabled: false,
      skipped: undefined,
    });
    const params = new URLSearchParams(encoded);
    expect(params.get('mode')).toBe('setup');
    expect(params.get('metadata[zendori_org_id]')).toBe('org 1');
    expect(params.get('allowed_payment_method_types[0]')).toBe('sepa_debit');
    expect(params.get('allowed_payment_method_types[1]')).toBe('card');
    expect(params.get('address[line1]')).toBe('Hauptstraße 1');
    // null unsets a value at Stripe: an empty string, not a missing key
    expect(params.get('address[line2]')).toBe('');
    expect(params.get('expand[0]')).toBe('invoice_settings.default_payment_method');
    expect(params.get('limit')).toBe('100');
    expect(params.get('enabled')).toBe('false');
    expect(params.has('skipped')).toBe(false);
  });
});

describe('stripeRequest', () => {
  it('sends the key, the pinned version and a form body', async () => {
    const { config, calls } = fakeStripe([{ status: 200, body: { id: 'cus_1' } }]);
    await stripeRequest(config, 'POST', '/v1/customers', {
      params: { name: 'Muster GmbH' },
      idempotencyKey: 'key-1',
    });
    const call = calls[0]!;
    expect(call.url).toBe('https://api.stripe.com/v1/customers');
    expect(call.headers.get('authorization')).toBe('Bearer sk_test_abc123');
    expect(call.headers.get('stripe-version')).toBe(STRIPE_API_VERSION);
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(call.headers.get('idempotency-key')).toBe('key-1');
    expect(call.body).toBe('name=Muster%20GmbH');
  });

  it('puts GET parameters into the query and sends no body', async () => {
    const { config, calls } = fakeStripe([{ status: 200, body: { data: [] } }]);
    await stripeRequest(config, 'GET', '/v1/customers/cus_1/tax_ids', { query: { limit: 100 } });
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/customers/cus_1/tax_ids?limit=100');
    expect(calls[0]!.body).toBeNull();
    expect(calls[0]!.headers.has('content-type')).toBe(false);
  });

  it('turns a Stripe error into a typed error without the request in the message', async () => {
    const { config } = fakeStripe([
      {
        status: 400,
        body: {
          error: {
            type: 'invalid_request_error',
            code: 'parameter_invalid_empty',
            param: 'email',
            message: 'Invalid email address: geheim@example.com',
          },
        },
      },
    ]);
    const error = await stripeRequest(config, 'POST', '/v1/customers/cus_1', {
      params: { email: 'geheim@example.com' },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StripeApiError);
    const apiError = error as StripeApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe('parameter_invalid_empty');
    expect(apiError.param).toBe('email');
    expect(apiError.requestId).toBe('req_1');
    expect(apiError.message).toBe('Stripe API request failed (POST, status 400)');
    expect(apiError.message).not.toContain('geheim');
    expect(stripeErrorCode(apiError)).toBe('stripe:400:parameter_invalid_empty');
    expect(isStripeRetryable(apiError)).toBe(false);
  });

  it('retries 429 and 409 for a write that has an idempotency key', async () => {
    const { config, calls, slept } = fakeStripe([
      { status: 429, body: { error: { type: 'rate_limit_error' } } },
      { status: 409, body: { error: { type: 'idempotency_error' } } },
      { status: 200, body: { id: 'cus_1' } },
    ]);
    const response = await stripeRequest(config, 'POST', '/v1/customers', {
      params: {},
      idempotencyKey: 'key-1',
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([500, 2000]);
    // every attempt carries the same key
    expect(new Set(calls.map((call) => call.headers.get('idempotency-key')))).toEqual(
      new Set(['key-1'])
    );
  });

  it('never repeats a write without an idempotency key', async () => {
    const busy = fakeStripe([{ status: 429, body: {} }]);
    await expect(
      stripeRequest(busy.config, 'POST', '/v1/checkout/sessions', { params: {} })
    ).rejects.toBeInstanceOf(StripeApiError);
    expect(busy.calls).toHaveLength(1);

    const offline = fakeStripe([{ throws: 'network' }]);
    await expect(
      stripeRequest(offline.config, 'POST', '/v1/checkout/sessions', { params: {} })
    ).rejects.toBeInstanceOf(StripeNetworkError);
    expect(offline.calls).toHaveLength(1);
  });

  it('retries a transport error for reads and keyed writes, then gives up', async () => {
    const read = fakeStripe([{ throws: 'network' }, { status: 200, body: { id: 'cus_1' } }]);
    await stripeRequest(read.config, 'GET', '/v1/customers/cus_1');
    expect(read.calls).toHaveLength(2);

    const dead = fakeStripe([{ throws: 'network' }, { throws: 'network' }, { throws: 'network' }]);
    const error = await stripeRequest(dead.config, 'POST', '/v1/customers', {
      params: {},
      idempotencyKey: 'key-1',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StripeNetworkError);
    expect(dead.calls).toHaveLength(3);
    expect(isStripeRetryable(error)).toBe(true);
    expect(stripeErrorCode(error)).toBe('network:network');
  });

  it('does not retry a 5xx (Stripe replays a stored 500 for the same key)', async () => {
    const { config, calls } = fakeStripe([{ status: 500, body: { error: { type: 'api_error' } } }]);
    const error = await stripeRequest(config, 'POST', '/v1/customers', {
      params: {},
      idempotencyKey: 'key-1',
    }).catch((caught: unknown) => caught);
    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(StripeApiError);
    // the caller's own schedule may try again later
    expect(isStripeRetryable(error)).toBe(true);
  });
});

describe('customers', () => {
  it('creates a customer with nothing but the org id, under a stable key', async () => {
    const { config, calls } = fakeStripe([{ status: 200, body: { id: 'cus_1', livemode: false } }]);
    const customer = await createStripeCustomer(config, { orgId: 'org-1', generation: 0 });
    expect(customer.id).toBe('cus_1');
    expect(calls[0]!.body).toBe('metadata%5Bzendori_org_id%5D=org-1');
    expect(calls[0]!.headers.get('idempotency-key')).toBe('zcus:org-1:0');
    // a customer that was deleted in Stripe is created again under a new key
    expect(customerIdempotencyKey('org-1', 1)).toBe('zcus:org-1:1');
  });

  it('writes name, address, language and tax flag', async () => {
    const { config, calls } = fakeStripe([{ status: 200, body: { id: 'cus_1' } }]);
    await updateStripeCustomer(config, 'cus_1', {
      name: 'Muster GmbH',
      email: 'rechnung@example.com',
      address: {
        line1: 'Hauptstraße 1',
        line2: null,
        postalCode: '1010',
        city: 'Wien',
        country: 'AT',
      },
      taxExempt: 'reverse',
    });
    const params = new URLSearchParams(calls[0]!.body ?? '');
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/customers/cus_1');
    expect(params.get('name')).toBe('Muster GmbH');
    expect(params.get('address[country]')).toBe('AT');
    expect(params.get('address[line2]')).toBe('');
    expect(params.get('preferred_locales[0]')).toBe('de');
    expect(params.get('tax_exempt')).toBe('reverse');
  });

  it('reports a missing or deleted customer as null', async () => {
    const missing = fakeStripe([
      { status: 404, body: { error: { code: 'resource_missing', type: 'invalid_request_error' } } },
    ]);
    expect(await retrieveStripeCustomer(missing.config, 'cus_gone')).toBeNull();

    const deleted = fakeStripe([{ status: 200, body: { id: 'cus_1', deleted: true } }]);
    expect(await retrieveStripeCustomer(deleted.config, 'cus_1')).toBeNull();

    const present = fakeStripe([
      {
        status: 200,
        body: {
          id: 'cus_1',
          tax_exempt: 'none',
          invoice_settings: {
            default_payment_method: {
              id: 'pm_1',
              type: 'sepa_debit',
              sepa_debit: { last4: '3000' },
            },
          },
        },
      },
    ]);
    const customer = await retrieveStripeCustomer(present.config, 'cus_1');
    expect(customer?.id).toBe('cus_1');
    expect(present.calls[0]!.url).toContain(
      'expand%5B0%5D=invoice_settings.default_payment_method'
    );
  });

  it('recognizes "not found"', () => {
    expect(isStripeNotFound(new StripeApiError(404, 'GET', '/v1/x'))).toBe(true);
    expect(
      isStripeNotFound(new StripeApiError(400, 'GET', '/v1/x', { code: 'resource_missing' }))
    ).toBe(true);
    expect(isStripeNotFound(new StripeApiError(400, 'GET', '/v1/x'))).toBe(false);
    expect(isStripeNotFound(new Error('x'))).toBe(false);
  });
});

describe('syncCustomerVatId', () => {
  const vat = (id: string, value: string, status = 'verified') => ({
    id,
    type: 'eu_vat',
    value,
    verification: { status },
  });

  it('leaves an unchanged VAT id alone (its check stands)', async () => {
    const { config, calls } = fakeStripe([
      { status: 200, body: { data: [vat('txi_1', 'ATU12345678')] } },
    ]);
    const result = await syncCustomerVatId(config, 'cus_1', 'ATU12345678');
    expect(result?.id).toBe('txi_1');
    expect(calls).toHaveLength(1);
  });

  it('replaces a changed VAT id: delete, then create', async () => {
    const { config, calls } = fakeStripe([
      { status: 200, body: { data: [vat('txi_1', 'ATU00000000')] } },
      { status: 200, body: { id: 'txi_1', deleted: true } },
      { status: 200, body: vat('txi_2', 'ATU12345678', 'pending') },
    ]);
    const result = await syncCustomerVatId(config, 'cus_1', 'ATU12345678');
    expect(result?.id).toBe('txi_2');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'DELETE', 'POST']);
    expect(calls[1]!.url).toBe('https://api.stripe.com/v1/customers/cus_1/tax_ids/txi_1');
    expect(new URLSearchParams(calls[2]!.body ?? '').get('type')).toBe('eu_vat');
    // no key: a key would bring back a tax id that was deleted in between
    expect(calls[2]!.headers.has('idempotency-key')).toBe(false);
  });

  it('removes duplicates and every VAT id when none is wanted', async () => {
    const { config, calls } = fakeStripe([
      { status: 200, body: { data: [vat('txi_1', 'ATU12345678'), vat('txi_2', 'ATU12345678')] } },
      { status: 200, body: { id: 'txi_2', deleted: true } },
    ]);
    expect((await syncCustomerVatId(config, 'cus_1', 'ATU12345678'))?.id).toBe('txi_1');
    expect(calls).toHaveLength(2);

    const none = fakeStripe([
      { status: 200, body: { data: [vat('txi_1', 'ATU12345678')] } },
      { status: 404, body: { error: { code: 'resource_missing' } } },
    ]);
    // a tax id that is already gone is fine
    expect(await syncCustomerVatId(none.config, 'cus_1', null)).toBeNull();
  });

  it('leaves tax ids of other kinds untouched', async () => {
    const { config, calls } = fakeStripe([
      {
        status: 200,
        body: { data: [{ id: 'txi_9', type: 'ch_vat', value: 'CHE-1', verification: null }] },
      },
    ]);
    expect(await syncCustomerVatId(config, 'cus_1', null)).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('checkout', () => {
  it('opens a setup session for SEPA and card in German, without a key', async () => {
    const { config, calls } = fakeStripe([
      {
        status: 200,
        body: { id: 'cs_1', mode: 'setup', url: 'https://checkout.stripe.com/c/pay/cs_1' },
      },
    ]);
    const session = await createSetupCheckoutSession(config, {
      customerId: 'cus_1',
      orgId: 'org-1',
      successUrl: 'https://app.example.com/settings/billing?payment=done',
      cancelUrl: 'https://app.example.com/settings/billing',
    });
    expect(session.url).toContain('checkout.stripe.com');
    const params = new URLSearchParams(calls[0]!.body ?? '');
    expect(params.get('mode')).toBe('setup');
    expect(params.get('customer')).toBe('cus_1');
    expect(params.get('currency')).toBe('eur');
    expect(params.get('allowed_payment_method_types[0]')).toBe('sepa_debit');
    expect(params.get('allowed_payment_method_types[1]')).toBe('card');
    expect(params.get('locale')).toBe('de');
    expect(params.get('client_reference_id')).toBe('org-1');
    expect(calls[0]!.headers.has('idempotency-key')).toBe(false);
  });
});

describe('webhook signature', () => {
  const body = '{"id":"evt_1","type":"customer.updated"}';
  const secret = 'whsec_test_secret';
  const nowSec = 1_800_000_000;
  const nowMs = nowSec * 1000;

  it('accepts a correctly signed payload', () => {
    const header = signStripePayload(body, secret, nowSec);
    expect(() => verifyStripeSignature(body, header, [secret], { nowMs })).not.toThrow();
  });

  it('accepts any of several secrets and any of several v1 entries', () => {
    const header = signStripePayload(body, secret, nowSec);
    expect(() =>
      verifyStripeSignature(body, header, ['whsec_other', secret], { nowMs })
    ).not.toThrow();
    const rolled = `${header},v1=${'0'.repeat(64)},v0=ignored,future=entry`;
    expect(() => verifyStripeSignature(body, rolled, [secret], { nowMs })).not.toThrow();
  });

  const reason = (run: () => void): string => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(StripeSignatureError);
      return (error as StripeSignatureError).reason;
    }
    return 'accepted';
  };

  it('rejects a changed body, a wrong secret and a missing header', () => {
    const header = signStripePayload(body, secret, nowSec);
    expect(reason(() => verifyStripeSignature(`${body} `, header, [secret], { nowMs }))).toBe(
      'no_match'
    );
    expect(reason(() => verifyStripeSignature(body, header, ['whsec_other'], { nowMs }))).toBe(
      'no_match'
    );
    expect(reason(() => verifyStripeSignature(body, null, [secret], { nowMs }))).toBe(
      'missing_header'
    );
    expect(reason(() => verifyStripeSignature(body, header, [], { nowMs }))).toBe('no_secret');
  });

  it('rejects malformed headers', () => {
    for (const header of [
      'v1=abc',
      't=abc,v1=abc',
      `t=${nowSec}`,
      'garbage',
      `t=${nowSec},v0=abc`,
    ]) {
      expect(reason(() => verifyStripeSignature(body, header, [secret], { nowMs }))).toBe(
        'malformed_header'
      );
    }
    // a non-hex signature simply does not match
    expect(
      reason(() => verifyStripeSignature(body, `t=${nowSec},v1=zzzz`, [secret], { nowMs }))
    ).toBe('no_match');
  });

  it('rejects a replay outside the tolerance, in both directions', () => {
    const old = signStripePayload(body, secret, nowSec - 301);
    expect(reason(() => verifyStripeSignature(body, old, [secret], { nowMs }))).toBe(
      'timestamp_out_of_tolerance'
    );
    const future = signStripePayload(body, secret, nowSec + 301);
    expect(reason(() => verifyStripeSignature(body, future, [secret], { nowMs }))).toBe(
      'timestamp_out_of_tolerance'
    );
    const edge = signStripePayload(body, secret, nowSec - 300);
    expect(reason(() => verifyStripeSignature(body, edge, [secret], { nowMs }))).toBe('accepted');
  });

  it('reads several secrets from one variable', () => {
    expect(parseStripeWebhookSecrets(' whsec_a , whsec_b ,, ')).toEqual(['whsec_a', 'whsec_b']);
    expect(parseStripeWebhookSecrets('')).toEqual([]);
    expect(parseStripeWebhookSecrets(undefined)).toEqual([]);
  });
});

describe('events', () => {
  it('keeps account events and ignores the rest', () => {
    expect(stripeEventScope('checkout.session.completed')).toBe('account');
    expect(stripeEventScope('customer.tax_id.updated')).toBe('account');
    expect(stripeEventScope('mandate.updated')).toBe('account');
    expect(stripeEventScope('charge.succeeded')).toBeNull();
    // never subscribe to this one: failing it delays Stripe's own finalization
    expect(stripeEventScope('invoice.created')).toBeNull();
  });

  it('extracts ids only', () => {
    const session = stripeEventSchema.parse({
      id: 'evt_1',
      type: 'checkout.session.completed',
      livemode: false,
      data: {
        object: {
          id: 'cs_1',
          object: 'checkout.session',
          customer: 'cus_1',
          customer_details: { email: 'x@example.com' },
        },
      },
    });
    expect(stripeEventRef(session)).toEqual({
      eventId: 'evt_1',
      type: 'checkout.session.completed',
      livemode: false,
      objectType: 'checkout.session',
      objectId: 'cs_1',
      customerId: 'cus_1',
    });

    const customer = stripeEventSchema.parse({
      id: 'evt_2',
      type: 'customer.updated',
      livemode: true,
      data: { object: { id: 'cus_9', object: 'customer' } },
    });
    expect(stripeEventRef(customer).customerId).toBe('cus_9');

    const detached = stripeEventSchema.parse({
      id: 'evt_3',
      type: 'payment_method.detached',
      livemode: true,
      data: { object: { id: 'pm_1', object: 'payment_method', customer: null } },
    });
    expect(stripeEventRef(detached)).toMatchObject({ objectId: 'pm_1', customerId: null });
  });

  it('rejects something that is not an event', () => {
    expect(stripeEventSchema.safeParse({ id: 'evt_1', type: 'x' }).success).toBe(false);
    expect(
      stripeEventSchema.safeParse({ id: '', type: 'x', livemode: true, data: { object: {} } })
        .success
    ).toBe(false);
  });
});
