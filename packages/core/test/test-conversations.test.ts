import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TEST_TICKET_REFUSED_CODE, isTestConversation } from '../src/test-conversations.js';

// isTestConversation is asked by every place that decides in code whether a
// conversation may cause something outside Zendori (tickets, HubSpot, learning).

function clientReturning(result: { data: unknown; error: { code: string } | null }): {
  client: SupabaseClient;
  filters: [string, unknown][];
} {
  const filters: [string, unknown][] = [];
  const query = {
    select: () => query,
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return query;
    },
    maybeSingle: async () => result,
  };
  return { client: { from: () => query } as unknown as SupabaseClient, filters };
}

describe('isTestConversation', () => {
  it('is true only for a conversation marked as a test', async () => {
    expect(
      await isTestConversation(clientReturning({ data: { is_test: true }, error: null }).client, 'o', 'c')
    ).toBe(true);
    expect(
      await isTestConversation(clientReturning({ data: { is_test: false }, error: null }).client, 'o', 'c')
    ).toBe(false);
    // not found (deleted, or another org's id)
    expect(await isTestConversation(clientReturning({ data: null, error: null }).client, 'o', 'c')).toBe(
      false
    );
  });

  it('looks the conversation up inside the given organization', async () => {
    const fake = clientReturning({ data: { is_test: true }, error: null });
    await isTestConversation(fake.client, 'org-1', 'conv-1');
    expect(fake.filters).toEqual([
      ['org_id', 'org-1'],
      ['id', 'conv-1'],
    ]);
  });

  it('before migration 0050 no conversation is a test', async () => {
    expect(
      await isTestConversation(clientReturning({ data: null, error: { code: '42703' } }).client, 'o', 'c')
    ).toBe(false);
  });

  it('any other database error is thrown, never read as "not a test"', async () => {
    await expect(
      isTestConversation(clientReturning({ data: null, error: { code: '57014' } }).client, 'o', 'c')
    ).rejects.toMatchObject({ code: '57014' });
  });

  it('the guard code is the one the migration raises', () => {
    expect(TEST_TICKET_REFUSED_CODE).toBe('ZT001');
  });
});
