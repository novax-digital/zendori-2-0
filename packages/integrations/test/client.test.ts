import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BASE_URL,
  HubSpotApiError,
  HubSpotAuthError,
  findTicketByRef,
  isSuccess,
  requestFailed,
  type HubSpotResponse,
} from '../src/index.js';
import { createMockFetch, mockConfig } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('isSuccess', () => {
  it('accepts 2xx only', () => {
    expect(isSuccess(200)).toBe(true);
    expect(isSuccess(204)).toBe(true);
    expect(isSuccess(299)).toBe(true);
    expect(isSuccess(199)).toBe(false);
    expect(isSuccess(400)).toBe(false);
    expect(isSuccess(500)).toBe(false);
  });
});

describe('request auth + base url', () => {
  it('sends a Bearer token and JSON content type to the default host', async () => {
    const { fetchImpl, requests } = createMockFetch([{ status: 200, body: { id: 't1' } }]);
    await findTicketByRef(mockConfig(fetchImpl, 'secret-tok'), 'ref-1');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.startsWith(DEFAULT_BASE_URL)).toBe(true);
    expect(requests[0]?.authorization).toBe('Bearer secret-tok');
    expect(requests[0]?.contentType).toBe('application/json');
  });
});

describe('request retry', () => {
  it('retries a 429 on the fixed backoff then returns the 200', async () => {
    vi.useFakeTimers();
    const { fetchImpl, requests } = createMockFetch([
      {
        status: 429,
        body: { policyName: 'TEN_SECONDLY_ROLLING' },
        headers: { 'X-HubSpot-RateLimit-Remaining': '0' },
      },
      { status: 200, body: { id: 't-after-429' } },
    ]);
    const promise = findTicketByRef(mockConfig(fetchImpl), 'ref-429');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toEqual({ id: 't-after-429' });
    expect(requests).toHaveLength(2);
  });

  it('retries a 5xx then surfaces the terminal failure after retries are exhausted', async () => {
    vi.useFakeTimers();
    const { fetchImpl, requests } = createMockFetch([
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
      { status: 500, body: { message: 'boom' } },
    ]);
    const promise = findTicketByRef(mockConfig(fetchImpl), 'ref-5xx');
    const assertion = expect(promise).rejects.toBeInstanceOf(HubSpotApiError);
    await vi.advanceTimersByTimeAsync(2000 + 8000);
    await assertion;
    // 1 initial + 2 retries = 3 attempts
    expect(requests).toHaveLength(3);
  });
});

describe('requestFailed', () => {
  const base: HubSpotResponse = {
    status: 0,
    json: null,
    bodyText: 'error text',
    policyName: null,
    rateLimitRemaining: null,
  };

  it('maps 401 to an invalid_token auth error', () => {
    const err = requestFailed('GET', '/x', { ...base, status: 401 });
    expect(err).toBeInstanceOf(HubSpotAuthError);
    expect((err as HubSpotAuthError).kind).toBe('invalid_token');
    expect(err.status).toBe(401);
  });

  it('maps 403 to a missing_scope auth error', () => {
    const err = requestFailed('GET', '/x', { ...base, status: 403 });
    expect(err).toBeInstanceOf(HubSpotAuthError);
    expect((err as HubSpotAuthError).kind).toBe('missing_scope');
  });

  it('maps other statuses to a plain api error and never leaks the path in the message', () => {
    const err = requestFailed(
      'GET',
      '/crm/v3/objects/contacts/secret@example.com?idProperty=email',
      { ...base, status: 500 }
    );
    expect(err).toBeInstanceOf(HubSpotApiError);
    expect(err).not.toBeInstanceOf(HubSpotAuthError);
    expect(err.message).not.toContain('secret@example.com');
    expect(err.path).toContain('secret@example.com'); // detail kept in field, not message
  });

  it('caps the body excerpt at 300 chars', () => {
    const err = requestFailed('GET', '/x', { ...base, status: 500, bodyText: 'a'.repeat(1000) });
    expect(err.bodyExcerpt).toHaveLength(300);
  });
});
