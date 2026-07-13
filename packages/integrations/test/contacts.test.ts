import { describe, expect, it } from 'vitest';
import { stripCountryCode, upsertContact } from '../src/index.js';
import { createMockFetch, mockConfig } from './helpers.js';

describe('stripCountryCode', () => {
  it('replaces a two-digit country code with 0', () => {
    expect(stripCountryCode('+491701234567')).toBe('01701234567');
  });
  it('replaces the +1 NANP code with 0', () => {
    expect(stripCountryCode('+15551234567')).toBe('05551234567');
  });
  it('replaces the +7 code with 0', () => {
    expect(stripCountryCode('+79161234567')).toBe('09161234567');
  });
  it('leaves a local number untouched', () => {
    expect(stripCountryCode('01701234567')).toBe('01701234567');
  });
});

describe('upsertContact by email', () => {
  it('returns the id when the contact already exists (GET 200)', async () => {
    const { fetchImpl, requests } = createMockFetch([{ status: 200, body: { id: 'c-existing' } }]);
    const ref = await upsertContact(mockConfig(fetchImpl), {
      email: 'a@b.de',
      name: 'Anna Beispiel',
    });
    expect(ref).toEqual({ id: 'c-existing' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toContain('idProperty=email');
  });

  it('creates the contact on GET 404, mapping name → firstname/lastname (no company)', async () => {
    const { fetchImpl, requests } = createMockFetch([
      { status: 404, body: { message: 'not found' } },
      { status: 201, body: { id: 'c-new' } },
    ]);
    const ref = await upsertContact(mockConfig(fetchImpl), {
      email: 'a@b.de',
      name: 'Anna von Beispiel',
      phone: '+49301112222',
    });
    expect(ref).toEqual({ id: 'c-new' });
    expect(requests).toHaveLength(2);
    const createBody = requests[1]?.body as { properties: Record<string, unknown> };
    expect(createBody.properties).toEqual({
      email: 'a@b.de',
      firstname: 'Anna',
      lastname: 'von Beispiel',
      phone: '+49301112222',
    });
    expect(createBody.properties).not.toHaveProperty('company');
  });

  it('re-GETs on a 409 create conflict', async () => {
    const { fetchImpl, requests } = createMockFetch([
      { status: 404, body: {} },
      { status: 409, body: { message: 'conflict' } },
      { status: 200, body: { id: 'c-raced' } },
    ]);
    const ref = await upsertContact(mockConfig(fetchImpl), { email: 'a@b.de' });
    expect(ref).toEqual({ id: 'c-raced' });
    expect(requests).toHaveLength(3);
    expect(requests[2]?.method).toBe('GET');
  });
});

describe('upsertContact by phone', () => {
  it('matches via phone EQ search', async () => {
    const { fetchImpl, requests } = createMockFetch([
      { status: 200, body: { results: [{ id: 'c-phone' }] } },
    ]);
    const ref = await upsertContact(mockConfig(fetchImpl), { phone: '+491701234567' });
    expect(ref).toEqual({ id: 'c-phone' });
    const searchBody = requests[0]?.body as {
      filterGroups: { filters: { propertyName: string; operator: string; value: string }[] }[];
    };
    expect(searchBody.filterGroups[0]?.filters[0]).toEqual({
      propertyName: 'phone',
      operator: 'EQ',
      value: '+491701234567',
    });
  });

  it('retries the search with stripCountryCode, then creates on a miss', async () => {
    const { fetchImpl, requests } = createMockFetch([
      { status: 200, body: { results: [] } }, // +49… miss
      { status: 200, body: { results: [] } }, // 0… miss
      { status: 201, body: { id: 'c-created' } },
    ]);
    const ref = await upsertContact(mockConfig(fetchImpl), { phone: '+491701234567' });
    expect(ref).toEqual({ id: 'c-created' });
    expect(requests).toHaveLength(3);
    const secondSearch = requests[1]?.body as {
      filterGroups: { filters: { value: string }[] }[];
    };
    expect(secondSearch.filterGroups[0]?.filters[0]?.value).toBe('01701234567');
  });
});

describe('upsertContact validation', () => {
  it('throws when neither email nor phone is provided', async () => {
    const { fetchImpl, requests } = createMockFetch([]);
    await expect(upsertContact(mockConfig(fetchImpl), { name: 'No Contact' })).rejects.toThrow(
      /neither email nor phone/
    );
    expect(requests).toHaveLength(0);
  });
});
