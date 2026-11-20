import { describe, expect, it } from 'vitest';
import { verifyStandardWebhook } from '@zendori/core';
import {
  CustomApiError,
  buildRequestHeaders,
  callCustomApi,
  generateSigningSecret,
  type CustomApiCall,
} from '../src/index.js';

// The custom-API client is exercised with an injected fetch — no real network.

interface Recorded {
  url: string;
  init: RequestInit;
}

function fetchReturning(response: () => Response, recorded: Recorded[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    recorded.push({ url: String(input), init: init ?? {} });
    return response();
  }) as typeof fetch;
}

function baseCall(overrides: Partial<CustomApiCall> = {}): CustomApiCall {
  return {
    url: 'https://api.example.com/v1/orders/4711',
    method: 'GET',
    body: null,
    auth: { kind: 'none' },
    requestId: '11111111-1111-4111-8111-111111111111',
    timeoutMs: 1000,
    ...overrides,
  };
}

describe('buildRequestHeaders', () => {
  it('always sends an idempotency key and a JSON accept header', () => {
    const headers = buildRequestHeaders(baseCall(), 1_700_000_000_000);
    expect(headers['idempotency-key']).toBe('11111111-1111-4111-8111-111111111111');
    expect(headers.accept).toBe('application/json');
    expect(headers['content-type']).toBeUndefined();
    expect(headers['webhook-signature']).toBeUndefined();
  });

  it('maps the three auth kinds to headers', () => {
    expect(
      buildRequestHeaders(baseCall({ auth: { kind: 'bearer', secret: 'tok' } }), 0).authorization
    ).toBe('Bearer tok');
    expect(
      buildRequestHeaders(
        baseCall({ auth: { kind: 'header', headerName: 'X-API-Key', secret: 'k' } }),
        0
      )['x-api-key']
    ).toBe('k');
    expect(
      buildRequestHeaders(baseCall({ auth: { kind: 'basic', username: 'u', secret: 'p' } }), 0)
        .authorization
    ).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('signs body requests so the end system can verify them (Standard Webhooks)', () => {
    const secret = generateSigningSecret();
    const body = JSON.stringify({ day: '2026-12-01' });
    const nowMs = 1_700_000_000_000;
    const headers = buildRequestHeaders(baseCall({ body, signingSecret: secret }), nowMs);
    expect(headers['content-type']).toBe('application/json');
    expect(() =>
      verifyStandardWebhook(
        body,
        {
          id: headers['webhook-id'] ?? null,
          timestamp: headers['webhook-timestamp'] ?? null,
          signature: headers['webhook-signature'] ?? null,
        },
        secret,
        Math.floor(nowMs / 1000)
      )
    ).not.toThrow();
  });

  it('a GET is signed over the empty body', () => {
    const secret = generateSigningSecret();
    const nowMs = 1_700_000_000_000;
    const headers = buildRequestHeaders(baseCall({ signingSecret: secret }), nowMs);
    expect(() =>
      verifyStandardWebhook(
        '',
        {
          id: headers['webhook-id'] ?? null,
          timestamp: headers['webhook-timestamp'] ?? null,
          signature: headers['webhook-signature'] ?? null,
        },
        secret,
        Math.floor(nowMs / 1000)
      )
    ).not.toThrow();
  });
});

describe('callCustomApi', () => {
  it('returns status and parsed JSON, never following redirects', async () => {
    const recorded: Recorded[] = [];
    const response = await callCustomApi(
      baseCall({
        fetchImpl: fetchReturning(
          () => new Response(JSON.stringify({ status: 'shipped' }), { status: 200 }),
          recorded
        ),
      })
    );
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ status: 'shipped' });
    expect(recorded[0]?.init.redirect).toBe('manual');
    expect(recorded[0]?.init.method).toBe('GET');
  });

  it('resolves for error statuses and non-JSON bodies (the caller decides)', async () => {
    const response = await callCustomApi(
      baseCall({ fetchImpl: fetchReturning(() => new Response('Not Found', { status: 404 })) })
    );
    expect(response.status).toBe(404);
    expect(response.json).toBeUndefined();
    expect(response.text).toBe('Not Found');
  });

  it('hands a redirect back as a plain 3xx response', async () => {
    const response = await callCustomApi(
      baseCall({
        fetchImpl: fetchReturning(
          () =>
            new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
        ),
      })
    );
    expect(response.status).toBe(302);
  });

  it('refuses a target the SSRF guard rejects, without calling fetch', async () => {
    const recorded: Recorded[] = [];
    await expect(
      callCustomApi(
        baseCall({
          fetchImpl: fetchReturning(() => new Response('{}'), recorded),
          assertUrl: async () => {
            throw new Error('private address');
          },
        })
      )
    ).rejects.toMatchObject({ code: 'blocked_url' });
    expect(recorded).toHaveLength(0);
  });

  it('maps a rejected fetch to network and an aborted one to timeout', async () => {
    await expect(
      callCustomApi(
        baseCall({
          fetchImpl: (async () => {
            throw new Error('ECONNREFUSED');
          }) as typeof fetch,
        })
      )
    ).rejects.toMatchObject({ code: 'network' });

    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    await expect(
      callCustomApi(baseCall({ timeoutMs: 20, fetchImpl: hanging }))
    ).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('rejects a response larger than the cap', async () => {
    await expect(
      callCustomApi(
        baseCall({
          maxResponseBytes: 100,
          fetchImpl: fetchReturning(() => new Response('x'.repeat(500), { status: 200 })),
        })
      )
    ).rejects.toBeInstanceOf(CustomApiError);
  });

  it('never puts the URL, the body or a secret into the error message', async () => {
    try {
      await callCustomApi(
        baseCall({
          url: 'https://api.example.com/orders?email=kunde@example.com',
          auth: { kind: 'bearer', secret: 'super-secret' },
          fetchImpl: (async () => {
            throw new Error('boom https://api.example.com/orders?email=kunde@example.com');
          }) as typeof fetch,
        })
      );
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('kunde@example.com');
      expect(message).not.toContain('super-secret');
    }
  });
});
