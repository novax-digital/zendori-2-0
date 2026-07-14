import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { Logger, SupabaseClient } from '@zendori/core';
import type { VoiceChannelConfig } from '@zendori/channels';
import { CallSession } from '../src/voice/call-session.js';

// Drives a real CallSession against an in-process mock xAI WebSocket server:
// scripted event sequences verify the greeting handshake, the CUMULATIVE
// transcript handling (xAI delta — naive concatenation would double text), the
// tool loop (N function_call_output frames then exactly ONE response.create),
// and the end_call → REST hangup path.

// --- fakes ---------------------------------------------------------------------

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

interface InsertedRow {
  table: string;
  row: Record<string, unknown>;
}

/** Chainable thenable fake for the small supabase surface the session uses. */
function makeFakeSupabase(seed: { maybeSingle?: Record<string, unknown> } = {}) {
  const inserts: InsertedRow[] = [];
  const updates: { table: string; patch: Record<string, unknown> }[] = [];
  let insertSeq = 0;

  function builder(table: string, op: { kind: string; insertId?: string }) {
    const singleData = op.insertId ? { id: op.insertId } : (seed.maybeSingle?.[table] ?? null);
    const chain: Record<string, unknown> = {};
    const self = new Proxy(chain, {
      get(_t, prop: string) {
        if (prop === 'then') {
          const result =
            op.kind === 'single' || op.kind === 'maybeSingle'
              ? { data: singleData, error: null }
              : { data: [], error: null };
          return (resolve: (v: unknown) => void) => resolve(result);
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return () => builder(table, { ...op, kind: op.kind === 'insert' ? 'single' : 'maybeSingle' });
        }
        return () => self;
      },
    });
    return self;
  }

  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          insertSeq += 1;
          return builder(table, { kind: 'insert', insertId: `fake-${table}-${insertSeq}` });
        },
        update(patch: Record<string, unknown>) {
          updates.push({ table, patch });
          return builder(table, { kind: 'update' });
        },
        select() {
          return builder(table, { kind: 'select' });
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

// --- harness ---------------------------------------------------------------------

let wss: WebSocketServer;
let serverSocket: ServerSocket | null;
let received: { type: string; [k: string]: unknown }[];
let port: number;
let fetchCalls: { url: string; method: string }[];
const realFetch = globalThis.fetch;

function serverSend(event: Record<string, unknown>): void {
  serverSocket?.send(JSON.stringify(event));
}

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const value = predicate();
      if (value !== undefined) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor timed out'));
      }
    }, 10);
  });
}

beforeEach(async () => {
  received = [];
  serverSocket = null;
  fetchCalls = [];
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once('listening', r));
  port = (wss.address() as { port: number }).port;
  wss.on('connection', (socket) => {
    serverSocket = socket;
    socket.on('message', (data) => {
      received.push(JSON.parse(String(data)) as { type: string });
    });
    socket.send(JSON.stringify({ type: 'session.created', session: {} }));
  });
  // Record REST call-control invocations (hangup/refer) without hitting xAI.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), method: init?.method ?? 'GET' });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  // Terminate lingering session sockets first — wss.close() only completes once
  // every client connection is gone, and CallSession keeps its socket open.
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  vi.restoreAllMocks();
});

function startSession(fake: ReturnType<typeof makeFakeSupabase>): CallSession {
  const session = new CallSession({
    supabase: fake.client,
    logger: silentLogger,
    apiKey: 'test-key',
    voiceCallId: '00000000-0000-4000-8000-000000000001',
    providerCallId: 'call-abc',
    orgId: '00000000-0000-4000-8000-0000000000aa',
    channelId: '00000000-0000-4000-8000-0000000000bb',
    conversationId: '00000000-0000-4000-8000-0000000000cc',
    channelConfig: CONFIG,
    agent: { mode: 'answer', identity: null },
    context: { companyName: 'Testfirma' },
    onClosed: () => undefined,
    wsUrl: `ws://127.0.0.1:${port}`,
  });
  session.start();
  return session;
}

async function completeHandshake(): Promise<void> {
  // client must respond to session.created with session.update …
  await waitFor(() => received.find((e) => e.type === 'session.update'));
  serverSend({ type: 'session.updated' });
  // … then greet via response.create
  await waitFor(() => received.find((e) => e.type === 'response.create'));
}

describe('CallSession protocol', () => {
  it('performs the handshake: session.update after created, response.create after updated', async () => {
    const fake = makeFakeSupabase();
    startSession(fake);
    await completeHandshake();

    const update = received.find((e) => e.type === 'session.update') as {
      session: {
        instructions: string;
        audio: { input: { format: { type: string; rate: number } } };
      };
    };
    expect(update.session.instructions).toContain('Testfirma');
    expect(update.session.audio.input.format).toEqual({ type: 'audio/pcmu', rate: 8000 });
    // voice_calls flipped to active
    await waitFor(() =>
      fake.updates.find((u) => u.table === 'voice_calls' && u.patch.status === 'active')
    );
  });

  it('handles the CUMULATIVE transcript without double-counting', async () => {
    const fake = makeFakeSupabase();
    startSession(fake);
    await completeHandshake();

    // xAI sends the FULL transcript each time (cumulative), not fragments.
    serverSend({
      type: 'conversation.item.input_audio_transcription.updated',
      item_id: 'item-1',
      transcript: 'Ich habe',
    });
    serverSend({
      type: 'conversation.item.input_audio_transcription.updated',
      item_id: 'item-1',
      transcript: 'Ich habe eine Frage',
    });
    serverSend({
      type: 'conversation.item.input_audio_transcription.updated',
      item_id: 'item-1',
      transcript: 'Ich habe eine Frage zur Lieferung.',
    });
    // a new response starts → the user turn is flushed
    serverSend({ type: 'response.created' });

    const insert = await waitFor(() =>
      fake.inserts.find((i) => i.table === 'messages' && i.row.direction === 'in')
    );
    expect(insert.row.content).toBe('Ich habe eine Frage zur Lieferung.');
    expect(insert.row.processing_state).toBe('skipped');
    // exactly one message for the item — no duplicate from the cumulative frames
    const inbound = fake.inserts.filter((i) => i.table === 'messages' && i.row.direction === 'in');
    expect(inbound).toHaveLength(1);
  });

  it('accumulates assistant transcript deltas into one bot message on response.done', async () => {
    const fake = makeFakeSupabase();
    startSession(fake);
    await completeHandshake();

    serverSend({ type: 'response.created' });
    serverSend({ type: 'response.audio_transcript.delta', delta: 'Gerne, ' });
    serverSend({ type: 'response.output_audio_transcript.delta', delta: 'einen Moment.' });
    serverSend({ type: 'response.done' });

    const insert = await waitFor(() =>
      fake.inserts.find((i) => i.table === 'messages' && i.row.sender_type === 'bot')
    );
    expect(insert.row.content).toBe('Gerne, einen Moment.');
  });

  it('answers tool calls with function_call_output frames and exactly ONE response.create', async () => {
    const fake = makeFakeSupabase({
      maybeSingle: { conversations: { contact_id: null } },
    });
    startSession(fake);
    await completeHandshake();
    const before = received.filter((e) => e.type === 'response.create').length;

    serverSend({ type: 'response.created' });
    serverSend({
      type: 'response.function_call_arguments.done',
      call_id: 'call-1',
      name: 'create_ticket',
      arguments: JSON.stringify({ subject: 'Rückruf', description: 'Kunde bittet um Rückruf.' }),
    });
    serverSend({
      type: 'response.function_call_arguments.done',
      call_id: 'call-2',
      name: 'kb_search',
      arguments: JSON.stringify({ query: 'Lieferzeit' }),
    });
    serverSend({ type: 'response.done' });

    await waitFor(() => {
      const outputs = received.filter((e) => e.type === 'conversation.item.create');
      return outputs.length >= 2 ? outputs : undefined;
    });
    const outputs = received.filter((e) => e.type === 'conversation.item.create') as {
      item: { type: string; call_id: string };
    }[];
    expect(outputs.map((o) => o.item.call_id).sort()).toEqual(['call-1', 'call-2']);
    expect(outputs.every((o) => o.item.type === 'function_call_output')).toBe(true);

    await waitFor(() =>
      received.filter((e) => e.type === 'response.create').length === before + 1 ? true : undefined
    );
    // give any stray extra frame a beat to arrive, then assert exactly one
    await new Promise((r) => setTimeout(r, 100));
    expect(received.filter((e) => e.type === 'response.create').length).toBe(before + 1);
  });

  it('end_call: acknowledges the tool and calls the REST hangup, then finalizes', async () => {
    const fake = makeFakeSupabase();
    startSession(fake);
    await completeHandshake();

    serverSend({ type: 'response.created' });
    serverSend({ type: 'response.audio_transcript.delta', delta: 'Auf Wiederhören!' });
    serverSend({
      type: 'response.function_call_arguments.done',
      call_id: 'call-9',
      name: 'end_call',
      arguments: '{}',
    });
    serverSend({ type: 'response.done' });

    await waitFor(() =>
      fetchCalls.find((c) => c.url.includes('/v1/realtime/calls/call-abc/hangup'))
    );
    // xAI closes the connection after hangup
    serverSocket?.close();

    const final = await waitFor(() =>
      fake.updates.find((u) => u.table === 'voice_calls' && u.patch.status === 'completed')
    );
    expect(final.patch.ended_reason).toBe('agent_end');
    // the farewell was persisted as a bot message
    expect(
      fake.inserts.some((i) => i.table === 'messages' && i.row.content === 'Auf Wiederhören!')
    ).toBe(true);
  });

  it('handoff with transferNumber: refer is invoked and the call is marked transferred', async () => {
    const fake = makeFakeSupabase();
    const session = new CallSession({
      supabase: fake.client,
      logger: silentLogger,
      apiKey: 'test-key',
      voiceCallId: '00000000-0000-4000-8000-000000000002',
      providerCallId: 'call-transfer',
      orgId: '00000000-0000-4000-8000-0000000000aa',
      channelId: '00000000-0000-4000-8000-0000000000bb',
      conversationId: '00000000-0000-4000-8000-0000000000cc',
      channelConfig: { ...CONFIG, transferNumber: '+491701112233' },
      agent: { mode: 'answer', identity: null },
      context: { companyName: 'Testfirma' },
      onClosed: () => undefined,
      wsUrl: `ws://127.0.0.1:${port}`,
    });
    session.start();
    await completeHandshake();

    serverSend({ type: 'response.created' });
    serverSend({
      type: 'response.function_call_arguments.done',
      call_id: 'call-h',
      name: 'handoff_human',
      arguments: JSON.stringify({ reason: 'user_request' }),
    });
    serverSend({ type: 'response.done' });

    await waitFor(() =>
      fetchCalls.find((c) => c.url.includes('/v1/realtime/calls/call-transfer/refer'))
    );
    // xAI tears the session down after a successful transfer.
    serverSocket?.close();
    await waitFor(() =>
      fake.updates.find((u) => u.table === 'voice_calls' && u.patch.status === 'transferred')
    );
    // mode flipped to human + handoff event recorded
    expect(fake.updates.some((u) => u.table === 'conversations' && u.patch.mode === 'human')).toBe(
      true
    );
    expect(fake.inserts.some((i) => i.table === 'handoff_events')).toBe(true);
    // the hold text was spoken via force_message (and no response.create after it)
    const force = received.filter(
      (e) =>
        e.type === 'conversation.item.create' &&
        (e as { item?: { type?: string } }).item?.type === 'force_message'
    );
    expect(force.length).toBe(1);
  });

  it('accumulates MULTIPLE text deltas when no audio transcript stream exists', async () => {
    const fake = makeFakeSupabase();
    startSession(fake);
    await completeHandshake();

    serverSend({ type: 'response.created' });
    serverSend({ type: 'response.text.delta', delta: 'Hallo' });
    serverSend({ type: 'response.text.delta', delta: ', wie kann ich' });
    serverSend({ type: 'response.text.delta', delta: ' Ihnen helfen?' });
    serverSend({ type: 'response.done' });

    const insert = await waitFor(() =>
      fake.inserts.find((i) => i.table === 'messages' && i.row.sender_type === 'bot')
    );
    expect(insert.row.content).toBe('Hallo, wie kann ich Ihnen helfen?');
  });

  it('treats a normal close (1000) as completed — no reconnect, no failed status', async () => {
    const fake = makeFakeSupabase();
    startSession(fake);
    await completeHandshake();

    // caller hangs up — provider closes the WS normally
    serverSocket?.close(1000, 'bye');

    const final = await waitFor(() =>
      fake.updates.find((u) => u.table === 'voice_calls' && typeof u.patch.status === 'string' && u.patch.status !== 'active')
    );
    expect(final.patch.status).toBe('completed');
    expect(final.patch.ended_reason).toBe('remote_close');
  });

  it('finalizes a session that never reached active as failed (connect_failed)', async () => {
    const fake = makeFakeSupabase();
    startSession(fake);
    // server sends session.created but never acks the session.update
    await waitFor(() => received.find((e) => e.type === 'session.update'));
    serverSocket?.close(1011, 'server error');

    const final = await waitFor(() =>
      fake.updates.find((u) => u.table === 'voice_calls' && u.patch.status === 'failed')
    );
    expect(final.patch.ended_reason).toBe('connect_failed');
  });

  it('late transcription.completed corrects an already-flushed user turn', async () => {
    const fake = makeFakeSupabase();
    startSession(fake);
    await completeHandshake();

    serverSend({
      type: 'conversation.item.input_audio_transcription.updated',
      item_id: 'item-9',
      transcript: 'Ich möchte gern',
    });
    // response starts → the interim hypothesis is flushed
    serverSend({ type: 'response.created' });
    await waitFor(() =>
      fake.inserts.find((i) => i.table === 'messages' && i.row.content === 'Ich möchte gern')
    );
    // the final ASR result arrives late with the corrected full text
    serverSend({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-9',
      transcript: 'Ich möchte gern meine Bestellung stornieren.',
    });

    const update = await waitFor(() =>
      fake.updates.find(
        (u) => u.table === 'messages' && u.patch.content === 'Ich möchte gern meine Bestellung stornieren.'
      )
    );
    expect(update).toBeDefined();
    // still exactly ONE inbound message (correction updates, not duplicates)
    const inbound = fake.inserts.filter((i) => i.table === 'messages' && i.row.direction === 'in');
    expect(inbound).toHaveLength(1);
  });
});
