import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@zendori/core';
import type { VoiceChannelConfig } from '@zendori/channels';
// Type-only import: erased at runtime, so it does not defeat the '@zendori/ai' mock.
import type { ToolContext } from '../src/voice/tools.js';

// The voice function-tools run in the worker with the org_id bound from server
// truth, so RLS-scoped tenant isolation holds. These tests exercise the three
// tool handlers against a fake supabase: kb_search's intake gating + RAG path,
// create_ticket's conversation-as-ticket + contact-gap fill (never overwrite),
// and handoff's transfer-vs-callback branch.

// kb_search calls the real RAG entrypoint — mock it so the test never embeds.
const retrieveMock = vi.fn();
vi.mock('@zendori/ai', () => ({
  retrieveRelevantChunks: retrieveMock,
  EMBEDDING_MODEL: 'text-embedding-3-small',
}));

// Imported AFTER the mock is registered.
const { kbSearchTool, createTicketTool, handoffTool } = await import('../src/voice/tools.js');

// --- fake supabase ---------------------------------------------------------------

interface Recorded {
  inserts: { table: string; row: Record<string, unknown> }[];
  updates: { table: string; patch: Record<string, unknown> }[];
}

/**
 * Chainable thenable fake. `singles` seeds the row returned by a
 * select().…maybeSingle() per table; `updateError` forces the update on a table
 * to return an error (to drive the failure branches).
 */
function makeFake(
  opts: { singles?: Record<string, unknown>; updateError?: Set<string> } = {}
): { client: SupabaseClient } & Recorded {
  const inserts: Recorded['inserts'] = [];
  const updates: Recorded['updates'] = [];
  const singles = opts.singles ?? {};
  const updateError = opts.updateError ?? new Set<string>();

  function makeChain(table: string, kind: 'select' | 'update' | 'insert') {
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            const result =
              kind === 'update'
                ? { data: null, error: updateError.has(table) ? { message: 'update failed' } : null }
                : { data: [], error: null };
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

const CONFIG: VoiceChannelConfig = {
  type: 'voice',
  provider: 'xai',
  phoneNumber: '+493022334455',
  dispatchSigningSecretEncrypted: 'v1:x:y',
  voice: 'eve',
  languageHint: 'de',
  keyterms: [],
  speechSpeed: 1.0,
  maxCallSeconds: 900,
  connectionState: 'active',
};

function ctxWith(
  fake: ReturnType<typeof makeFake>,
  over: Partial<ToolContext> = {}
): ToolContext {
  return {
    supabase: fake.client,
    orgId: 'org-1',
    conversationId: 'conv-1',
    channelId: 'chan-1',
    channelConfig: CONFIG,
    agentMode: 'answer',
    knowledgeBaseIds: null,
    ...over,
  };
}

beforeEach(() => {
  retrieveMock.mockReset();
});

// --- kb_search -------------------------------------------------------------------

describe('kbSearchTool', () => {
  it('is gated off in intake_only mode without touching RAG', async () => {
    const fake = makeFake();
    const result = await kbSearchTool(ctxWith(fake, { agentMode: 'intake_only' }), {
      query: 'Lieferzeit',
    });
    expect(result).toEqual({ ok: false, error: 'kb_search ist in diesem Modus nicht verfügbar' });
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments', async () => {
    const fake = makeFake();
    const result = await kbSearchTool(ctxWith(fake), { query: '' });
    expect(result).toEqual({ ok: false, error: 'invalid arguments' });
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it('returns capped chunks, logs an ai_runs row, and disables rerank for latency', async () => {
    retrieveMock.mockResolvedValue({
      matches: [
        { id: 'k1', source_id: 'src-1', content: 'x'.repeat(1000), similarity: 0.8 },
        { id: 'k2', source_id: 'src-2', content: 'kurz', similarity: 0.5 },
      ],
      embedCostUsd: 0.0001,
      searchMode: 'hybrid',
    });
    const fake = makeFake();
    const result = await kbSearchTool(ctxWith(fake, { knowledgeBaseIds: ['kb-9'] }), {
      query: 'Wie lange dauert die Lieferung?',
    });

    expect(result.ok).toBe(true);
    const chunks = (result as { chunks: { content: string; source_id: string }[] }).chunks;
    expect(chunks).toHaveLength(2);
    // 800-char snippet cap
    expect(chunks[0]?.content.length).toBe(800);
    expect(chunks[0]?.source_id).toBe('src-1');

    // voice keeps rerank OFF (latency) and passes the agent's kb scope + 0.3 gate.
    expect(retrieveMock).toHaveBeenCalledWith(
      fake.client,
      'org-1',
      'Wie lange dauert die Lieferung?',
      expect.objectContaining({ rerank: false, minSimilarity: 0.3, knowledgeBaseIds: ['kb-9'] })
    );
    // one ai_runs row for the retrieve step
    const run = fake.inserts.find((i) => i.table === 'ai_runs');
    expect(run?.row.step).toBe('retrieve');
    expect(run?.row.org_id).toBe('org-1');
  });
});

// --- create_ticket ---------------------------------------------------------------

describe('createTicketTool', () => {
  it('sets the subject, fills empty contact gaps, and writes a system message', async () => {
    const fake = makeFake({
      singles: {
        conversations: { contact_id: 'contact-1' },
        contacts: { name: null, email: null },
      },
    });
    const result = await createTicketTool(ctxWith(fake), {
      subject: 'Rückruf gewünscht',
      description: 'Kunde bittet um Rückruf zur Rechnung.',
      name: 'Kai Beispiel',
      callback_number: '+49 170 1234567',
      email: 'kai@example.com',
    });

    expect(result).toEqual({ ok: true, ticket_ref: 'conv-1' });
    // subject set on the conversation
    expect(
      fake.updates.find((u) => u.table === 'conversations')?.patch.subject
    ).toBe('Rückruf gewünscht');
    // contact gaps filled (both were null)
    const contactPatch = fake.updates.find((u) => u.table === 'contacts')?.patch;
    expect(contactPatch).toEqual({ name: 'Kai Beispiel', email: 'kai@example.com' });
    // structured system message with all provided lines
    const msg = fake.inserts.find((i) => i.table === 'messages');
    expect(msg?.row.sender_type).toBe('system');
    expect(String(msg?.row.content)).toContain('Ticket aufgenommen: Rückruf gewünscht');
    expect(String(msg?.row.content)).toContain('Rückruf: +49 170 1234567');
    expect(String(msg?.row.content)).toContain('E-Mail: kai@example.com');
  });

  it('never overwrites an existing contact name/email', async () => {
    const fake = makeFake({
      singles: {
        conversations: { contact_id: 'contact-1' },
        contacts: { name: 'Bestehender Name', email: 'alt@example.com' },
      },
    });
    await createTicketTool(ctxWith(fake), {
      subject: 'Frage',
      description: 'Text',
      name: 'Neuer Name',
      email: 'neu@example.com',
    });
    // both slots already filled → no contact update at all
    expect(fake.updates.some((u) => u.table === 'contacts')).toBe(false);
  });

  it('drops a syntactically invalid email but still records the ticket', async () => {
    const fake = makeFake({
      singles: {
        conversations: { contact_id: 'contact-1' },
        contacts: { name: null, email: null },
      },
    });
    const result = await createTicketTool(ctxWith(fake), {
      subject: 'Frage',
      description: 'Text',
      email: 'kai [at] example dot com',
    });
    expect(result.ok).toBe(true);
    // invalid email never reaches contacts.email …
    const contactPatch = fake.updates.find((u) => u.table === 'contacts')?.patch;
    expect(contactPatch?.email).toBeUndefined();
    // … and is not printed in the system message
    const msg = fake.inserts.find((i) => i.table === 'messages');
    expect(String(msg?.row.content)).not.toContain('E-Mail:');
  });

  it('returns ok:false when the subject update fails', async () => {
    const fake = makeFake({ updateError: new Set(['conversations']) });
    const result = await createTicketTool(ctxWith(fake), {
      subject: 'Frage',
      description: 'Text',
    });
    expect(result).toEqual({ ok: false, error: 'Ticket konnte nicht gespeichert werden' });
    // failed before any contact/message write
    expect(fake.inserts.some((i) => i.table === 'messages')).toBe(false);
  });

  it('rejects invalid arguments', async () => {
    const fake = makeFake();
    const result = await createTicketTool(ctxWith(fake), { subject: '', description: '' });
    expect(result).toEqual({ ok: false, error: 'invalid arguments' });
  });
});

// --- handoff_human ---------------------------------------------------------------

describe('handoffTool', () => {
  it('signals a live transfer when a transferNumber is configured', async () => {
    const fake = makeFake();
    const result = await handoffTool(
      ctxWith(fake, { channelConfig: { ...CONFIG, transferNumber: '+491701112233' } }),
      { reason: 'user_request' }
    );
    expect(result).toEqual({ ok: true, action: 'transfer', transfer_number: '+491701112233' });
    // conversation flipped to human/pending + handoff_event recorded
    expect(
      fake.updates.some(
        (u) => u.table === 'conversations' && u.patch.mode === 'human' && u.patch.status === 'pending'
      )
    ).toBe(true);
    const event = fake.inserts.find((i) => i.table === 'handoff_events');
    expect(event?.row.reason).toBe('user_request');
  });

  it('offers a callback when no transferNumber is set', async () => {
    const fake = makeFake();
    const result = await handoffTool(ctxWith(fake), { reason: 'low_confidence' });
    expect(result.ok).toBe(true);
    expect((result as { action: string }).action).toBe('callback');
    // still flips to human and records the event
    expect(fake.inserts.some((i) => i.table === 'handoff_events')).toBe(true);
  });

  it('treats a blank transferNumber as no transfer', async () => {
    const fake = makeFake();
    const result = await handoffTool(
      ctxWith(fake, { channelConfig: { ...CONFIG, transferNumber: '   ' } }),
      { reason: 'keyword' }
    );
    expect((result as { action: string }).action).toBe('callback');
  });

  it('returns ok:false when the conversation update fails', async () => {
    const fake = makeFake({ updateError: new Set(['conversations']) });
    const result = await handoffTool(ctxWith(fake), { reason: 'user_request' });
    expect(result).toEqual({ ok: false, error: 'Übergabe fehlgeschlagen' });
    expect(fake.inserts.some((i) => i.table === 'handoff_events')).toBe(false);
  });

  it('rejects an unknown reason', async () => {
    const fake = makeFake();
    const result = await handoffTool(ctxWith(fake), { reason: 'because' });
    expect(result).toEqual({ ok: false, error: 'invalid arguments' });
  });
});
