import { describe, expect, it } from 'vitest';
import {
  apiBaseUrlSchema,
  apiConnectionAuthSchema,
  buildActionRequest,
  buildActionToolSchema,
  capActionResult,
  checkDataActionDefinition,
  coerceActionValues,
  dataActionNameSchema,
  dataActionParametersSchema,
  dataActionPathSchema,
  dataActionResponseFieldsSchema,
  mapActionResponse,
  pickPath,
  resolveActionValues,
  type DataActionParameter,
} from '../src/data-actions.js';

function params(raw: unknown[]): DataActionParameter[] {
  return dataActionParametersSchema.parse(raw);
}

const ORDER_PARAMS = params([
  { key: 'order_id', in: 'path', source: 'agent', description: 'Bestellnummer' },
  { key: 'email', in: 'query', source: 'context', contextKey: 'contact.email' },
  { key: 'lang', in: 'query', source: 'fixed', fixedValue: 'de' },
  { key: 'details', in: 'query', source: 'agent', type: 'boolean', required: false },
]);

describe('data action schemas', () => {
  it('accepts a tool name and rejects built-in tool names and bad shapes', () => {
    expect(dataActionNameSchema.safeParse('bestellstatus_abfragen').success).toBe(true);
    expect(dataActionNameSchema.safeParse('kb_search').success).toBe(false);
    expect(dataActionNameSchema.safeParse('create_ticket').success).toBe(false);
    expect(dataActionNameSchema.safeParse('Bestell-Status').success).toBe(false);
    expect(dataActionNameSchema.safeParse('ab').success).toBe(false);
  });

  it('path: needs a leading slash, no query, no dot segments, well-formed placeholders', () => {
    expect(dataActionPathSchema.safeParse('/orders/{order_id}/items').success).toBe(true);
    expect(dataActionPathSchema.safeParse('orders').success).toBe(false);
    expect(dataActionPathSchema.safeParse('/orders?x=1').success).toBe(false);
    expect(dataActionPathSchema.safeParse('/a/../admin').success).toBe(false);
    expect(dataActionPathSchema.safeParse('/orders/{Order}').success).toBe(false);
    expect(dataActionPathSchema.safeParse('/orders/{order_id').success).toBe(false);
  });

  it('parameters: unique keys, context needs a key, fixed needs a value, path is required', () => {
    expect(
      dataActionParametersSchema.safeParse([
        { key: 'a', in: 'query', source: 'agent' },
        { key: 'a', in: 'body', source: 'agent' },
      ]).success
    ).toBe(false);
    expect(
      dataActionParametersSchema.safeParse([{ key: 'a', in: 'query', source: 'context' }]).success
    ).toBe(false);
    expect(
      dataActionParametersSchema.safeParse([{ key: 'a', in: 'query', source: 'fixed' }]).success
    ).toBe(false);
    expect(
      dataActionParametersSchema.safeParse([
        { key: 'a', in: 'path', source: 'agent', required: false },
      ]).success
    ).toBe(false);
  });

  it('rejects prototype-polluting field names and response paths', () => {
    expect(
      dataActionParametersSchema.safeParse([
        { key: 'a', in: 'body', source: 'agent', field: '__proto__.polluted' },
      ]).success
    ).toBe(false);
    expect(dataActionResponseFieldsSchema.safeParse(['constructor.prototype']).success).toBe(false);
    expect(dataActionResponseFieldsSchema.safeParse(['order.items.name']).success).toBe(true);
  });

  it('base URL: https only, no credentials, no query; trailing slash removed', () => {
    expect(apiBaseUrlSchema.parse('https://api.example.com/v1/')).toBe(
      'https://api.example.com/v1'
    );
    expect(apiBaseUrlSchema.safeParse('http://api.example.com').success).toBe(false);
    expect(apiBaseUrlSchema.safeParse('https://user:pw@api.example.com').success).toBe(false);
    expect(apiBaseUrlSchema.safeParse('https://api.example.com?x=1').success).toBe(false);
    expect(apiBaseUrlSchema.safeParse('not a url').success).toBe(false);
  });

  it('auth: a custom header may not override transport or signature headers', () => {
    const base = { kind: 'header', secret_encrypted: 'v1:a:b' };
    expect(apiConnectionAuthSchema.safeParse({ ...base, header_name: 'X-API-Key' }).success).toBe(
      true
    );
    expect(apiConnectionAuthSchema.safeParse({ ...base, header_name: 'Host' }).success).toBe(false);
    expect(
      apiConnectionAuthSchema.safeParse({ ...base, header_name: 'webhook-signature' }).success
    ).toBe(false);
  });
});

describe('checkDataActionDefinition', () => {
  it('flags a placeholder without a path parameter and vice versa', () => {
    expect(
      checkDataActionDefinition({ method: 'GET', path: '/orders/{order_id}', parameters: [] })
    ).toBe('placeholder_without_parameter');
    expect(
      checkDataActionDefinition({
        method: 'GET',
        path: '/orders',
        parameters: params([{ key: 'order_id', in: 'path', source: 'agent' }]),
      })
    ).toBe('path_parameter_without_placeholder');
  });

  it('flags body parameters on GET/DELETE and passes a consistent definition', () => {
    const body = params([{ key: 'note', in: 'body', source: 'agent' }]);
    expect(checkDataActionDefinition({ method: 'GET', path: '/x', parameters: body })).toBe(
      'body_parameter_on_bodyless_method'
    );
    expect(checkDataActionDefinition({ method: 'POST', path: '/x', parameters: body })).toBeNull();
    expect(
      checkDataActionDefinition({
        method: 'GET',
        path: '/orders/{order_id}',
        parameters: ORDER_PARAMS,
      })
    ).toBeNull();
  });
});

describe('resolveActionValues', () => {
  it('takes agent parameters from the model and context parameters from the server', () => {
    const result = resolveActionValues(
      ORDER_PARAMS,
      { order_id: ' 4711 ', details: 'true' },
      { 'contact.email': 'kunde@example.com' }
    );
    expect(result).toEqual({
      ok: true,
      values: { order_id: '4711', email: 'kunde@example.com', details: true },
    });
  });

  it('ignores a model attempt to set a context or fixed parameter', () => {
    const result = resolveActionValues(
      ORDER_PARAMS,
      { order_id: '1', email: 'opfer@example.com', lang: 'en' },
      { 'contact.email': 'kunde@example.com' }
    );
    expect(result.ok && result.values.email).toBe('kunde@example.com');
    expect(result.ok && 'lang' in result.values).toBe(false);
  });

  it('reports a missing context value separately from bad model arguments', () => {
    expect(resolveActionValues(ORDER_PARAMS, { order_id: '1' }, {})).toEqual({
      ok: false,
      error: 'missing_context',
      key: 'email',
    });
    expect(resolveActionValues(ORDER_PARAMS, {}, { 'contact.email': 'k@example.com' })).toEqual({
      ok: false,
      error: 'invalid_args',
      key: 'order_id',
    });
  });

  it('never drops a wrongly typed optional argument silently', () => {
    expect(
      resolveActionValues(
        ORDER_PARAMS,
        { order_id: '1', details: 'vielleicht' },
        {
          'contact.email': 'k@example.com',
        }
      )
    ).toEqual({ ok: false, error: 'invalid_args', key: 'details' });
  });

  it('tolerates non-object model arguments', () => {
    expect(
      resolveActionValues(ORDER_PARAMS, 'DROP TABLE', { 'contact.email': 'k@example.com' })
    ).toEqual({
      ok: false,
      error: 'invalid_args',
      key: 'order_id',
    });
  });
});

describe('coerceActionValues', () => {
  const typed = params([
    { key: 'count', in: 'query', source: 'agent', type: 'integer' },
    { key: 'price', in: 'query', source: 'agent', type: 'number', required: false },
    { key: 'state', in: 'query', source: 'agent', options: ['open', 'closed'], required: false },
  ]);

  it('coerces numeric strings and enforces integer and option lists', () => {
    expect(coerceActionValues(typed, { count: '3', price: '9.5', state: 'open' })).toEqual({
      ok: true,
      values: { count: 3, price: 9.5, state: 'open' },
    });
    expect(coerceActionValues(typed, { count: '3.5' })).toEqual({
      ok: false,
      error: 'invalid_args',
      key: 'count',
    });
    expect(coerceActionValues(typed, { count: 1, state: 'deleted' })).toEqual({
      ok: false,
      error: 'invalid_args',
      key: 'state',
    });
  });
});

describe('buildActionRequest', () => {
  it('fills the path, the query and fixed values below the base URL', () => {
    const request = buildActionRequest(
      { method: 'GET', path: '/orders/{order_id}', parameters: ORDER_PARAMS },
      'https://api.example.com/v1',
      { order_id: '4711', email: 'kunde@example.com', details: true }
    );
    expect(request).toEqual({
      url: 'https://api.example.com/v1/orders/4711?email=kunde%40example.com&lang=de&details=true',
      method: 'GET',
      body: null,
    });
  });

  it('encodes a path value as ONE segment — no traversal, no injected query', () => {
    const request = buildActionRequest(
      {
        method: 'GET',
        path: '/orders/{order_id}',
        parameters: params([{ key: 'order_id', in: 'path', source: 'agent' }]),
      },
      'https://api.example.com/v1',
      { order_id: '../../admin?x=1#y' }
    );
    expect(request.url).toBe('https://api.example.com/v1/orders/..%2F..%2Fadmin%3Fx%3D1%23y');
    expect(new URL(request.url).origin).toBe('https://api.example.com');
  });

  it('builds a nested JSON body from dot-path fields', () => {
    const request = buildActionRequest(
      {
        method: 'POST',
        path: '/appointments',
        parameters: params([
          { key: 'day', in: 'body', source: 'agent', field: 'slot.day' },
          { key: 'hour', in: 'body', source: 'agent', type: 'integer', field: 'slot.hour' },
          {
            key: 'email',
            in: 'body',
            source: 'context',
            contextKey: 'contact.email',
            field: 'customer.email',
          },
          { key: 'source', in: 'body', source: 'fixed', fixedValue: 'zendori' },
        ]),
      },
      'https://api.example.com',
      { day: '2026-12-01', hour: 14, email: 'kunde@example.com' }
    );
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body as string)).toEqual({
      slot: { day: '2026-12-01', hour: 14 },
      customer: { email: 'kunde@example.com' },
      source: 'zendori',
    });
  });

  it('throws when a path value is missing instead of calling a wrong URL', () => {
    expect(() =>
      buildActionRequest(
        { method: 'GET', path: '/orders/{order_id}', parameters: ORDER_PARAMS },
        'https://api.example.com',
        {}
      )
    ).toThrow();
  });
});

describe('buildActionToolSchema', () => {
  it('exposes only agent parameters to the model', () => {
    expect(buildActionToolSchema(ORDER_PARAMS)).toEqual({
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Bestellnummer' },
        details: { type: 'boolean' },
      },
      required: ['order_id'],
    });
  });
});

describe('response mapping', () => {
  const body = {
    status: 'shipped',
    secret_margin: 0.4,
    delivery: { date: '2026-12-03', carrier: 'DHL' },
    items: [
      { name: 'Akku', price: 99, internal_cost: 40 },
      { name: 'Kabel', price: 9, internal_cost: 2 },
    ],
  };

  it('pickPath walks objects and maps over arrays', () => {
    expect(pickPath(body, 'delivery.date')).toBe('2026-12-03');
    expect(pickPath(body, 'items.name')).toEqual(['Akku', 'Kabel']);
    expect(pickPath(body, 'items.1.name')).toBe('Kabel');
    expect(pickPath(body, 'missing.field')).toBeUndefined();
  });

  it('keeps only allowlisted fields', () => {
    expect(mapActionResponse(body, ['status', 'delivery.date', 'items.name'])).toEqual({
      status: 'shipped',
      'delivery.date': '2026-12-03',
      'items.name': ['Akku', 'Kabel'],
    });
  });

  it('returns the whole body without an allowlist and maps a top-level array', () => {
    expect(mapActionResponse(body, [])).toBe(body);
    expect(mapActionResponse(body.items, ['name'])).toEqual([{ name: 'Akku' }, { name: 'Kabel' }]);
  });

  it('caps oversized results', () => {
    expect(capActionResult({ a: 1 })).toEqual({ a: 1 });
    const capped = capActionResult({ text: 'x'.repeat(5000) }, 100) as {
      truncated: boolean;
      excerpt: string;
    };
    expect(capped.truncated).toBe(true);
    expect(capped.excerpt).toHaveLength(100);
    expect(capActionResult(undefined)).toBeNull();
  });
});
