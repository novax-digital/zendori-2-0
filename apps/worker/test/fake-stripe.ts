// A tiny in-memory Stripe for worker tests: just the endpoints the billing jobs
// call, with real object state (customers, payment methods, tax ids), honoured
// idempotency keys and a log of every request. No network is ever touched.
import type { StripeConfig } from '@zendori/integrations';

type Obj = Record<string, unknown>;

export interface FakeCall {
  method: string;
  path: string;
  params: URLSearchParams;
  idempotencyKey: string | null;
}

export interface FakeStripe {
  config: StripeConfig;
  calls: FakeCall[];
  accountId: string;
  customers: Map<string, Obj>;
  paymentMethods: Map<string, Obj>;
  taxIds: Map<string, Obj[]>;
  setupIntents: Map<string, Obj>;
  sessions: Map<string, Obj>;
  mandates: Map<string, Obj>;
  /** Queue failures: the next matching request answers with this status. */
  failNext(match: (call: FakeCall) => boolean, status: number, code?: string): void;
  /** Calls that changed something at Stripe. */
  writes(): FakeCall[];
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'request-id': 'req_fake' } });
}

function notFound(): Response {
  return reply(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
}

export function createFakeStripe(accountId = 'acct_test'): FakeStripe {
  const calls: FakeCall[] = [];
  const customers = new Map<string, Obj>();
  const paymentMethods = new Map<string, Obj>();
  const taxIds = new Map<string, Obj[]>();
  const setupIntents = new Map<string, Obj>();
  const sessions = new Map<string, Obj>();
  const mandates = new Map<string, Obj>();
  const idempotent = new Map<string, Obj>();
  const failures: { match: (call: FakeCall) => boolean; status: number; code?: string }[] = [];
  let sequence = 0;
  const nextId = (prefix: string): string => `${prefix}_${(sequence += 1)}`;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const call: FakeCall = {
      method,
      path: url.pathname,
      params:
        method === 'POST' && typeof init?.body === 'string'
          ? new URLSearchParams(init.body)
          : url.searchParams,
      idempotencyKey: headers.get('idempotency-key'),
    };
    calls.push(call);

    const failure = failures.findIndex((entry) => entry.match(call));
    if (failure >= 0) {
      const [entry] = failures.splice(failure, 1);
      return reply(entry!.status, { error: { type: 'api_error', code: entry!.code } });
    }

    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "v1"
    const [resource, id, sub, subId] = parts;

    if (resource === 'account') return reply(200, { id: accountId, country: 'DE' });

    if (resource === 'customers' && !id && method === 'POST') {
      const key = call.idempotencyKey;
      if (key && idempotent.has(key)) return reply(200, idempotent.get(key));
      const customer: Obj = {
        id: nextId('cus'),
        object: 'customer',
        livemode: false,
        tax_exempt: 'none',
        metadata: { zendori_org_id: call.params.get('metadata[zendori_org_id]') },
        invoice_settings: { default_payment_method: null },
      };
      customers.set(customer.id as string, customer);
      if (key) idempotent.set(key, customer);
      return reply(200, customer);
    }

    if (resource === 'customers' && id && !sub) {
      const customer = customers.get(id);
      if (!customer) return notFound();
      if (customer.deleted) {
        return method === 'GET'
          ? reply(200, { id, object: 'customer', deleted: true })
          : notFound();
      }
      if (method === 'POST') {
        for (const field of ['name', 'email', 'tax_exempt']) {
          const value = call.params.get(field);
          if (value !== null) customer[field] = value;
        }
        const country = call.params.get('address[country]');
        if (country !== null)
          customer.address = { country, line2: call.params.get('address[line2]') };
        const method = call.params.get('invoice_settings[default_payment_method]');
        if (method !== null) {
          const paymentMethod = paymentMethods.get(method);
          if (!paymentMethod || paymentMethod.customer !== id) {
            return reply(400, {
              error: { type: 'invalid_request_error', code: 'resource_missing' },
            });
          }
          customer.invoice_settings = { default_payment_method: method };
        }
        return reply(200, customer);
      }
      const settings = customer.invoice_settings as { default_payment_method: string | null };
      const expanded = settings.default_payment_method
        ? (paymentMethods.get(settings.default_payment_method) ?? null)
        : null;
      return reply(200, { ...customer, invoice_settings: { default_payment_method: expanded } });
    }

    if (resource === 'customers' && id && sub === 'tax_ids') {
      if (!customers.get(id) || customers.get(id)?.deleted) return notFound();
      const list = taxIds.get(id) ?? [];
      if (method === 'GET') return reply(200, { object: 'list', data: list, has_more: false });
      if (method === 'POST') {
        const taxId: Obj = {
          id: nextId('txi'),
          type: call.params.get('type'),
          value: call.params.get('value'),
          verification: { status: 'pending' },
        };
        taxIds.set(id, [...list, taxId]);
        return reply(200, taxId);
      }
      if (method === 'DELETE' && subId) {
        if (!list.some((entry) => entry.id === subId)) return notFound();
        taxIds.set(
          id,
          list.filter((entry) => entry.id !== subId)
        );
        return reply(200, { id: subId, deleted: true });
      }
    }

    const lookup: Record<string, Map<string, Obj>> = {
      payment_methods: paymentMethods,
      setup_intents: setupIntents,
      mandates,
    };
    if (resource && lookup[resource] && id && method === 'GET') {
      const found = lookup[resource]!.get(id);
      return found ? reply(200, found) : notFound();
    }
    if (resource === 'checkout' && id === 'sessions' && sub && method === 'GET') {
      const session = sessions.get(sub);
      if (!session) return notFound();
      const intent =
        typeof session.setup_intent === 'string' ? setupIntents.get(session.setup_intent) : null;
      return reply(200, { ...session, setup_intent: intent ?? session.setup_intent });
    }

    return reply(400, { error: { type: 'invalid_request_error', code: 'fake_unhandled' } });
  }) as unknown as typeof fetch;

  return {
    config: { secretKey: 'sk_test_fake', fetchImpl, sleep: async () => {} },
    calls,
    accountId,
    customers,
    paymentMethods,
    taxIds,
    setupIntents,
    sessions,
    mandates,
    failNext(match, status, code) {
      failures.push({ match, status, code });
    },
    writes() {
      return calls.filter((call) => call.method !== 'GET');
    },
  };
}
