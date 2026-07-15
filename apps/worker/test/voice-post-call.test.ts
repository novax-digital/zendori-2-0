import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@zendori/core';

// Post-call AI over a finished voice transcript: classify → priority, extract →
// subject/contact. These tests mock the AI boundary and the service client so
// they cover the orchestration only: empty-transcript short-circuit, the
// keep-specific-subject rule, contact-gap filling, the success stamp, the
// terminal stamp, and retry-on-error (no stamp so pg-boss retries).

const { classifyMock, extractMock, dbHolder } = vi.hoisted(() => ({
  classifyMock: vi.fn(),
  extractMock: vi.fn(),
  dbHolder: { client: undefined as unknown },
}));

vi.mock('@zendori/ai', () => ({
  AI_MODELS: { classify: 'claude-haiku-4-5', draft: 'claude-sonnet-4-6' },
  classify: classifyMock,
  extract: extractMock,
}));
// Silence the module-level pino logger so the retry-on-error test stays quiet.
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
}));

const { processPostCall, markPostCallTerminal } = await import('../src/pipeline/post-call.js');

// --- fake supabase ---------------------------------------------------------------

interface Recorded {
  inserts: { table: string; row: Record<string, unknown> }[];
  updates: { table: string; patch: Record<string, unknown> }[];
}

/**
 * `singles` seeds select().…maybeSingle() results per table; `lists` seeds the
 * awaited (non-single) select result per table (used for the messages turns).
 */
function makeFake(opts: {
  singles?: Record<string, unknown>;
  lists?: Record<string, unknown[]>;
}): { client: SupabaseClient } & Recorded {
  const inserts: Recorded['inserts'] = [];
  const updates: Recorded['updates'] = [];
  const singles = opts.singles ?? {};
  const lists = opts.lists ?? {};

  function makeChain(table: string, kind: 'select' | 'update' | 'insert') {
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            const result =
              kind === 'select'
                ? { data: lists[table] ?? [], error: null }
                : { data: null, error: null };
            return (resolve: (v: unknown) => void) => resolve(result);
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return async () => ({ data: singles[table] ?? null, error: null });
          }
          return () => proxy; // eq / in / is / order / limit / select
        },
      }
    );
    return proxy;
  }

  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return makeChain(table, 'insert');
        },
        update(patch: Record<string, unknown>) {
          updates.push({ table, patch });
          return makeChain(table, 'update');
        },
        select() {
          return makeChain(table, 'select');
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, inserts, updates };
}

const CALL_ROW = {
  id: 'call-1',
  org_id: 'org-1',
  channel_id: 'chan-1',
  conversation_id: 'conv-1',
  status: 'completed',
  post_processed_at: null,
};

const TURNS = [
  { direction: 'in', sender_type: 'contact', content: 'Wann kommt meine Bestellung?' },
  { direction: 'out', sender_type: 'bot', content: 'Ich schaue nach.' },
];

function classificationResult(over: Record<string, unknown> = {}) {
  return {
    result: {
      language: 'de',
      intent: 'lieferstatus',
      priority: 'high',
      wants_human: false,
      is_spam: false,
      is_auto_reply: false,
      summary: 'Frage zum Lieferstatus.',
      ...over,
    },
    costUsd: 0.0002,
  };
}

function extractionResult(over: Record<string, unknown> = {}) {
  return {
    result: {
      contact: { name: 'Kai Beispiel', email: 'kai@example.com', phone: null },
      subject: 'Frage zum Lieferstatus',
      description: 'Kunde fragt nach dem Status der Bestellung.',
      category: 'Frage',
      missing_fields: [],
      questions: [],
      confidence: 0.8,
      ...over,
    },
    costUsd: 0.0003,
  };
}

beforeEach(() => {
  classifyMock.mockReset();
  extractMock.mockReset();
});

describe('processPostCall', () => {
  it('short-circuits when the call is gone or already processed', async () => {
    const fake = makeFake({ singles: { voice_calls: { ...CALL_ROW, post_processed_at: 'x' } } });
    dbHolder.client = fake.client;
    await processPostCall('call-1');
    expect(classifyMock).not.toHaveBeenCalled();
    expect(fake.updates).toHaveLength(0);
  });

  it('stamps and stops for a transcript-less (missed) call without calling the AI', async () => {
    const fake = makeFake({ singles: { voice_calls: CALL_ROW }, lists: { messages: [] } });
    dbHolder.client = fake.client;
    await processPostCall('call-1');
    expect(classifyMock).not.toHaveBeenCalled();
    expect(extractMock).not.toHaveBeenCalled();
    // exactly the stamp
    const stamp = fake.updates.find((u) => u.table === 'voice_calls');
    expect(stamp?.patch.post_processed_at).toBeTruthy();
  });

  it('sets priority + extracted subject over a default subject and fills contact gaps', async () => {
    classifyMock.mockResolvedValue(classificationResult({ priority: 'urgent' }));
    extractMock.mockResolvedValue(extractionResult());
    const fake = makeFake({
      singles: {
        voice_calls: CALL_ROW,
        organizations: { name: 'Testfirma' },
        conversations: { subject: 'Anruf von +4930…', contact_id: 'contact-1' },
        contacts: { name: null, email: null },
      },
      lists: { messages: TURNS },
    });
    dbHolder.client = fake.client;

    await processPostCall('call-1');

    const convUpdate = fake.updates.find((u) => u.table === 'conversations');
    expect(convUpdate?.patch.priority).toBe('urgent');
    expect(convUpdate?.patch.subject).toBe('Frage zum Lieferstatus');
    // contact gaps filled from the extraction (email lowercased)
    const contactUpdate = fake.updates.find((u) => u.table === 'contacts');
    expect(contactUpdate?.patch).toEqual({ name: 'Kai Beispiel', email: 'kai@example.com' });
    // both AI steps logged
    expect(fake.inserts.filter((i) => i.table === 'ai_runs')).toHaveLength(2);
    // success stamp
    expect(fake.updates.some((u) => u.table === 'voice_calls' && u.patch.post_processed_at)).toBe(
      true
    );
  });

  it('keeps a specific (non-default) subject set by the agent/tool', async () => {
    classifyMock.mockResolvedValue(classificationResult({ priority: 'normal' }));
    extractMock.mockResolvedValue(extractionResult({ subject: 'Etwas anderes' }));
    const fake = makeFake({
      singles: {
        voice_calls: CALL_ROW,
        organizations: { name: 'Testfirma' },
        conversations: { subject: 'Defekte Wallbox', contact_id: 'contact-1' },
        contacts: { name: 'Kai', email: 'kai@example.com' },
      },
      lists: { messages: TURNS },
    });
    dbHolder.client = fake.client;

    await processPostCall('call-1');

    const convUpdate = fake.updates.find((u) => u.table === 'conversations');
    expect(convUpdate?.patch.priority).toBe('normal');
    // subject NOT overwritten
    expect(convUpdate?.patch.subject).toBeUndefined();
    // contact already complete → no contact update
    expect(fake.updates.some((u) => u.table === 'contacts')).toBe(false);
  });

  it('does not stamp when the AI throws, so pg-boss retries', async () => {
    classifyMock.mockRejectedValue(new Error('anthropic 529'));
    const fake = makeFake({
      singles: {
        voice_calls: CALL_ROW,
        organizations: { name: 'Testfirma' },
        conversations: { subject: 'Anruf von X', contact_id: 'contact-1' },
      },
      lists: { messages: TURNS },
    });
    dbHolder.client = fake.client;

    await expect(processPostCall('call-1')).rejects.toThrow('anthropic 529');
    // no post_processed_at stamp written
    expect(fake.updates.some((u) => u.table === 'voice_calls' && u.patch.post_processed_at)).toBe(
      false
    );
  });
});

describe('markPostCallTerminal', () => {
  it('stamps post_processed_at so the scan stops re-enqueuing', async () => {
    const fake = makeFake({});
    dbHolder.client = fake.client;
    await markPostCallTerminal('call-1');
    const stamp = fake.updates.find((u) => u.table === 'voice_calls');
    expect(stamp?.patch.post_processed_at).toBeTruthy();
  });
});
