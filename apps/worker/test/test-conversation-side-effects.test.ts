import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@zendori/core';

// Test conversations (migration 0050) outside the message pipeline: every way
// of asking for a HubSpot sync ends in syncConversation, and every human reply
// may become a learning candidate. Both jobs must let a test pass by.

const { learnMock, dbHolder } = vi.hoisted(() => ({
  learnMock: vi.fn(),
  dbHolder: { client: undefined as unknown },
}));

vi.mock('@zendori/ai', () => ({
  AI_MODELS: { classify: 'claude-haiku-4-5', draft: 'claude-sonnet-4-6' },
  learn: learnMock,
}));
vi.mock('@zendori/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const silent = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return silent;
    },
  };
  return { ...actual, createLogger: () => silent };
});
vi.mock('../src/db.js', () => ({
  getServiceClient: () => dbHolder.client,
  toErrorInfo: (e: unknown) => ({ name: 'e', message: String(e) }),
  isMissingColumnError: (e: unknown) =>
    (e as { code?: string } | null)?.code === '42703' ||
    (e as { code?: string } | null)?.code === 'PGRST204',
}));

const { syncConversation } = await import('../src/pipeline/hubspot-sync.js');
const { distillLearnedAnswer } = await import('../src/pipeline/learn.js');

interface Recorded {
  updates: { table: string; patch: Record<string, unknown> }[];
  touched: string[];
}

/** `singles` answers select().…maybeSingle() per table; lists are empty. */
function makeFake(singles: Record<string, unknown>): { client: SupabaseClient } & Recorded {
  const updates: Recorded['updates'] = [];
  const touched: string[] = [];
  function chain(table: string): unknown {
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'then') {
            return (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return async () => ({ data: singles[table] ?? null, error: null });
          }
          return () => proxy;
        },
      }
    );
    return proxy;
  }
  const client = {
    from(table: string) {
      touched.push(table);
      return {
        select: () => chain(table),
        insert: () => chain(table),
        update(patch: Record<string, unknown>) {
          updates.push({ table, patch });
          return chain(table);
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, updates, touched };
}

const CONVERSATION = {
  id: 'conv-1',
  org_id: 'org-1',
  channel_id: 'chan-1',
  contact_id: null,
  subject: null,
  status: 'open',
  priority: 'normal',
  external_refs: {},
  hubspot_synced_at: null,
  channel: { id: 'chan-1', type: 'chat', name: 'Website-Chat' },
};

beforeEach(() => {
  learnMock.mockReset();
});

describe('HubSpot sync', () => {
  it('a test conversation is stamped as handled without looking at the integration', async () => {
    const fake = makeFake({ conversations: { ...CONVERSATION, is_test: true } });
    dbHolder.client = fake.client;
    await syncConversation('conv-1');
    expect(fake.touched).not.toContain('integrations');
    // stamped, so the scan stops picking it up again
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]?.table).toBe('conversations');
    expect(Object.keys(fake.updates[0]?.patch ?? {})).toEqual(['hubspot_synced_at']);
  });

  it('a real conversation still goes on to the integration lookup', async () => {
    const fake = makeFake({ conversations: { ...CONVERSATION, is_test: false } });
    dbHolder.client = fake.client;
    await syncConversation('conv-1');
    expect(fake.touched).toContain('integrations');
  });
});

describe('learning loop', () => {
  const candidate = {
    id: 'la-1',
    org_id: 'org-1',
    conversation_id: 'conv-1',
    message_id: 'msg-9',
    origin: 'handoff_resolution',
    status: 'candidate',
  };
  const answer = {
    id: 'msg-9',
    conversation_id: 'conv-1',
    content: 'Der Versand dauert zwei Werktage.',
    created_at: new Date().toISOString(),
  };

  it('a reply typed in a test conversation never becomes knowledge', async () => {
    const fake = makeFake({
      learned_answers: candidate,
      conversations: { is_test: true },
      messages: answer,
    });
    dbHolder.client = fake.client;
    await distillLearnedAnswer('la-1');
    expect(learnMock).not.toHaveBeenCalled();
    expect(fake.updates).toEqual([{ table: 'learned_answers', patch: { status: 'auto_rejected' } }]);
    // rejected before the reply itself is even read
    expect(fake.touched).not.toContain('messages');
  });

  it('a reply in a real conversation is read as before', async () => {
    const fake = makeFake({
      learned_answers: candidate,
      conversations: { is_test: false },
      messages: answer,
    });
    dbHolder.client = fake.client;
    await distillLearnedAnswer('la-1');
    // the fake has no earlier customer message, so nothing is distilled — but
    // the job got past the test check and read the conversation's messages
    expect(fake.touched).toContain('messages');
  });
});
