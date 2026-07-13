// Test utilities: an injected fetch that serves queued responses and records the
// requests it received. No real network is ever touched.
import type { HubSpotConfig } from '../src/index.js';

export interface MockResponseSpec {
  status: number;
  /** Response JSON body (stringified); omit for an empty body. */
  body?: unknown;
  /** Response headers (e.g. X-HubSpot-RateLimit-Remaining). */
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

export interface MockFetch {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
}

/**
 * Build a fetch that returns `specs` in order (throws if called more times than
 * specs provided, so a test that expects N calls fails loudly on an extra one).
 */
export function createMockFetch(specs: MockResponseSpec[]): MockFetch {
  const requests: RecordedRequest[] = [];
  let call = 0;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const spec = specs[call];
    call += 1;
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
      body,
    });
    if (!spec) throw new Error(`unexpected fetch call #${call} to ${url}`);
    const responseHeaders = new Headers(spec.headers);
    const bodyText = spec.body === undefined ? '' : JSON.stringify(spec.body);
    return new Response(bodyText.length > 0 ? bodyText : null, {
      status: spec.status,
      headers: responseHeaders,
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

/** A HubSpotConfig wired to a mock fetch. */
export function mockConfig(fetchImpl: typeof fetch, token = 'test-token'): HubSpotConfig {
  return { token, fetchImpl };
}
