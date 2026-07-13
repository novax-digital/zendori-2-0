import { describe, expect, it } from 'vitest';
import { provisionTicketProperties } from '../src/index.js';
import { createMockFetch, mockConfig } from './helpers.js';

describe('provisionTicketProperties', () => {
  it('creates both properties when neither exists (GET 404 → POST)', async () => {
    const { fetchImpl, requests } = createMockFetch([
      { status: 404, body: {} }, // GET zendori_ref
      { status: 201, body: { name: 'zendori_ref' } }, // POST zendori_ref
      { status: 404, body: {} }, // GET zendori_source
      { status: 201, body: { name: 'zendori_source' } }, // POST zendori_source
    ]);
    const result = await provisionTicketProperties(mockConfig(fetchImpl));
    expect(result.created).toEqual(['zendori_ref', 'zendori_source']);
    expect(result.existing).toEqual([]);

    const refBody = requests[1]?.body as Record<string, unknown>;
    expect(refBody).toMatchObject({
      name: 'zendori_ref',
      label: 'Zendori Referenz',
      groupName: 'ticketinformation',
      hasUniqueValue: true,
    });
    const sourceBody = requests[3]?.body as Record<string, unknown>;
    expect(sourceBody).toMatchObject({ name: 'zendori_source', hasUniqueValue: false });
  });

  it('skips creation when a property already exists (GET 200)', async () => {
    const { fetchImpl, requests } = createMockFetch([
      { status: 200, body: { name: 'zendori_ref' } }, // GET zendori_ref exists
      { status: 200, body: { name: 'zendori_source' } }, // GET zendori_source exists
    ]);
    const result = await provisionTicketProperties(mockConfig(fetchImpl));
    expect(result.created).toEqual([]);
    expect(result.existing).toEqual(['zendori_ref', 'zendori_source']);
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('creates only the missing property', async () => {
    const { fetchImpl } = createMockFetch([
      { status: 200, body: { name: 'zendori_ref' } }, // exists
      { status: 404, body: {} }, // zendori_source missing
      { status: 201, body: { name: 'zendori_source' } },
    ]);
    const result = await provisionTicketProperties(mockConfig(fetchImpl));
    expect(result.existing).toEqual(['zendori_ref']);
    expect(result.created).toEqual(['zendori_source']);
  });
});
