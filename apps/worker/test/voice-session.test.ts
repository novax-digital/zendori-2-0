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
    agent: { mode: 'answer', identity: null, knowledgeBaseIds: null },
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
        audio: {
          input: { format?: unknown; transcription: { language_hint: string } };
          output: { format?: unknown };
        };
      };
    };
    expect(update.session.instructions).toContain('Testfirma');
    // Live-gate: NO explicit audio formats — the SIP bridge negotiates G.711
    // itself; forcing pcmu made the caller hear noise (2026-07-15).
    expect(update.session.audio.input.format).toBeUndefined();
    expect(update.session.audio.output.format).toBeUndefined();
    expect(update.session.audio.input.transcription.language_hint).toBe('de');
    // voice_calls flipped to active
    await waitFor(() =>
      fake.updates.find((u) => u.table === 'voice_calls' && u.patch.status === 'active')
    );
  });

  it('recording: greeting still fires if the notice never emits response.done (fallback timer)', async () => {
    const fake = makeFakeSupabase();
    const session = new CallSession({
      supabase: fake.client,
      logger: silentLogger,
      apiKey: 'test-key',
      voiceCallId: '00000000-0000-4000-8000-000000000004',
      providerCallId: 'call-fallback',
      orgId: '00000000-0000-4000-8000-0000000000aa',
      channelId: '00000000-0000-4000-8000-0000000000bb',
      conversationId: '00000000-0000-4000-8000-0000000000cc',
      channelConfig: { ...CONFIG, recordingEnabled: true },
      agent: { mode: 'answer', identity: null, knowledgeBaseIds: null },
      context: { companyName: 'Testfirma' },
      recordingEnabled: true,
      greetFallbackMs: 40,
      onClosed: () => undefined,
      wsUrl: `ws://127.0.0.1:${port}`,
    });
    session.start();
    await waitFor(() => received.find((e) => e.type === 'session.update'));
    serverSend({ type: 'session.updated' });

    // The §201 notice force_message is spoken …
    await waitFor(() =>
      received.find(
        (e) =>
          e.type === 'conversation.item.create' &&
          (e as { item?: { type?: string } }).item?.type === 'force_message'
      )
    );
    // … and WITHOUT any response.done for the notice, the fallback timer must
    // still fire the greeting so the caller is never left in silence.
    await waitFor(() => received.find((e) => e.type === 'response.create'));
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
      agent: { mode: 'answer', identity: null, knowledgeBaseIds: null },
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

  it('failed refer: function outputs sent, response.create deferred to the hold turn response.done', async () => {
    const fake = makeFakeSupabase();
    // refer fails with 500; everything else keeps succeeding
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, method: init?.method ?? 'GET' });
      return new Response('{}', { status: url.includes('/refer') ? 500 : 200 });
    }) as typeof fetch;

    const session = new CallSession({
      supabase: fake.client,
      logger: silentLogger,
      apiKey: 'test-key',
      voiceCallId: '00000000-0000-4000-8000-000000000007',
      providerCallId: 'call-refer-fail',
      orgId: '00000000-0000-4000-8000-0000000000aa',
      channelId: '00000000-0000-4000-8000-0000000000bb',
      conversationId: '00000000-0000-4000-8000-0000000000cc',
      channelConfig: { ...CONFIG, transferNumber: '+491701112233' },
      agent: { mode: 'answer', identity: null, knowledgeBaseIds: null },
      context: { companyName: 'Testfirma' },
      greetFallbackMs: 5_000,
      onClosed: () => undefined,
      wsUrl: `ws://127.0.0.1:${port}`,
    });
    session.start();
    await completeHandshake();
    // the model-generated greeting IS a response.create — count from here on
    const countCreates = () => received.filter((e) => e.type === 'response.create').length;
    const baseline = countCreates();

    serverSend({ type: 'response.created' });
    serverSend({
      type: 'response.function_call_arguments.done',
      call_id: 'call-h',
      name: 'handoff_human',
      arguments: JSON.stringify({ reason: 'user_request' }),
    });
    serverSend({ type: 'response.done' });

    // The callback-instruction function output goes out after the failed refer …
    await waitFor(() =>
      received.find(
        (e) =>
          e.type === 'conversation.item.create' &&
          (e as { item?: { type?: string } }).item?.type === 'function_call_output'
      )
    );
    // … but the response.create is DEFERRED (hold force_message still speaking).
    expect(countCreates()).toBe(baseline);

    // The hold turn completes → the deferred response.create fires.
    serverSend({ type: 'response.created' });
    serverSend({ type: 'response.done' });
    await waitFor(() => (countCreates() === baseline + 1 ? true : undefined));
    // the session stays live (no transferred/failed finalization)
    expect(
      fake.updates.find((u) => u.table === 'voice_calls' && u.patch.status === 'transferred')
    ).toBeUndefined();
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

  it('recording: speaks the §201 consent notice, then defers the greeting to its response.done', async () => {
    const fake = makeFakeSupabase();
    const session = new CallSession({
      supabase: fake.client,
      logger: silentLogger,
      apiKey: 'test-key',
      voiceCallId: '00000000-0000-4000-8000-000000000003',
      providerCallId: 'call-rec',
      orgId: '00000000-0000-4000-8000-0000000000aa',
      channelId: '00000000-0000-4000-8000-0000000000bb',
      conversationId: '00000000-0000-4000-8000-0000000000cc',
      channelConfig: { ...CONFIG, recordingEnabled: true },
      agent: { mode: 'answer', identity: null, knowledgeBaseIds: null },
      context: { companyName: 'Testfirma' },
      recordingEnabled: true,
      onClosed: () => undefined,
      wsUrl: `ws://127.0.0.1:${port}`,
    });
    session.start();
    // Handshake, but the greeting is DEFERRED when recording: session.updated
    // triggers the §201 notice force_message, not the greeting.
    await waitFor(() => received.find((e) => e.type === 'session.update'));
    serverSend({ type: 'session.updated' });

    // The §201 consent notice is a force_message spoken FIRST …
    await waitFor(() =>
      received.find(
        (e) =>
          e.type === 'conversation.item.create' &&
          (e as { item?: { type?: string } }).item?.type === 'force_message'
      )
    );
    // … and the greeting must NOT be sent yet — it waits for the notice's
    // response.done (sending it mid-force_message would drop it → dead air).
    expect(received.find((e) => e.type === 'response.create')).toBeUndefined();

    // The notice turn completes → the greeting fires now, back-to-back.
    serverSend({ type: 'response.created' });
    serverSend({ type: 'response.done' });
    await waitFor(() => received.find((e) => e.type === 'response.create'));

    // Frame order: notice force_message precedes the greeting response.create.
    const forceIdx = received.findIndex(
      (e) =>
        e.type === 'conversation.item.create' &&
        (e as { item?: { type?: string } }).item?.type === 'force_message'
    );
    const greetIdx = received.findIndex((e) => e.type === 'response.create');
    expect(forceIdx).toBeGreaterThan(-1);
    expect(forceIdx).toBeLessThan(greetIdx);

    // No per-call Twilio recording is started from the session anymore —
    // capture is trunk-wide; the post-call job fetches it.
    expect(fetchCalls.filter((c) => c.url.includes('/Recordings'))).toHaveLength(0);
  });

  it('without recording enabled: no force_message before the greeting, no Twilio call', async () => {
    const fake = makeFakeSupabase();
    startSession(fake);
    await completeHandshake();
    const force = received.filter(
      (e) =>
        e.type === 'conversation.item.create' &&
        (e as { item?: { type?: string } }).item?.type === 'force_message'
    );
    expect(force).toHaveLength(0);
    expect(fetchCalls.filter((c) => c.url.includes('/Recordings'))).toHaveLength(0);
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

  // --- configured greeting via force_message (2026-07-21) -------------------------

  const findForceMessage = () =>
    received.find(
      (e) =>
        e.type === 'conversation.item.create' &&
        (e as { item?: { type?: string } }).item?.type === 'force_message'
    ) as
      | { item: { interruptible?: boolean; content: { text?: string }[] } }
      | undefined;

  function startGreetingSession(
    fake: ReturnType<typeof makeFakeSupabase>,
    configOverrides: Partial<VoiceChannelConfig>
  ): CallSession {
    const session = new CallSession({
      supabase: fake.client,
      logger: silentLogger,
      apiKey: 'test-key',
      voiceCallId: '00000000-0000-4000-8000-000000000005',
      providerCallId: 'call-greet',
      orgId: '00000000-0000-4000-8000-0000000000aa',
      channelId: '00000000-0000-4000-8000-0000000000bb',
      conversationId: '00000000-0000-4000-8000-0000000000cc',
      channelConfig: { ...CONFIG, ...configOverrides },
      agent: { mode: 'answer', identity: null, knowledgeBaseIds: null },
      context: { companyName: 'Testfirma' },
      onClosed: () => undefined,
      wsUrl: `ws://127.0.0.1:${port}`,
    });
    session.start();
    return session;
  }

  it('configured greeting is spoken via force_message, non-interruptible by default', async () => {
    const fake = makeFakeSupabase();
    startGreetingSession(fake, { greeting: 'Willkommen bei Testfirma!' });
    await waitFor(() => received.find((e) => e.type === 'session.update'));
    serverSend({ type: 'session.updated' });

    const force = await waitFor(findForceMessage);
    expect(force.item.interruptible).toBe(false);
    expect(force.item.content[0]?.text).toBe('Willkommen bei Testfirma!');
    // The greeting IS the turn — no response.create alongside it.
    expect(received.find((e) => e.type === 'response.create')).toBeUndefined();
  });

  it('greetingInterruptible=true is passed through to the force_message', async () => {
    const fake = makeFakeSupabase();
    startGreetingSession(fake, {
      greeting: 'Willkommen!',
      greetingInterruptible: true,
    });
    await waitFor(() => received.find((e) => e.type === 'session.update'));
    serverSend({ type: 'session.updated' });

    const force = await waitFor(findForceMessage);
    expect(force.item.interruptible).toBe(true);
  });

  it('config.recordingEnabled alone (without the session param) does NOT trigger the notice', async () => {
    // The notice is driven by the recordingEnabled SESSION PARAM (dispatch
    // resolves it) — a stale config flag alone must not speak the notice.
    const fake = makeFakeSupabase();
    startGreetingSession(fake, {
      greeting: 'Willkommen bei Testfirma!',
      recordingEnabled: true,
    });
    await waitFor(() => received.find((e) => e.type === 'session.update'));
    serverSend({ type: 'session.updated' });
    const force = await waitFor(findForceMessage);
    expect(force.item.content[0]?.text).toBe('Willkommen bei Testfirma!');
  });

  it('recording session + configured greeting: notice force_message, then greeting force_message', async () => {
    const fake = makeFakeSupabase();
    const session = new CallSession({
      supabase: fake.client,
      logger: silentLogger,
      apiKey: 'test-key',
      voiceCallId: '00000000-0000-4000-8000-000000000006',
      providerCallId: 'call-rec-greet',
      orgId: '00000000-0000-4000-8000-0000000000aa',
      channelId: '00000000-0000-4000-8000-0000000000bb',
      conversationId: '00000000-0000-4000-8000-0000000000cc',
      channelConfig: { ...CONFIG, greeting: 'Willkommen!', recordingEnabled: true },
      agent: { mode: 'answer', identity: null, knowledgeBaseIds: null },
      context: { companyName: 'Testfirma' },
      recordingEnabled: true,
      onClosed: () => undefined,
      wsUrl: `ws://127.0.0.1:${port}`,
    });
    session.start();
    await waitFor(() => received.find((e) => e.type === 'session.update'));
    serverSend({ type: 'session.updated' });

    // First force_message = the §201 notice.
    await waitFor(findForceMessage);
    const forceMessages = () =>
      received.filter(
        (e) =>
          e.type === 'conversation.item.create' &&
          (e as { item?: { type?: string } }).item?.type === 'force_message'
      ) as { item: { content: { text?: string }[] } }[];
    expect(forceMessages()[0]!.item.content[0]?.text).toContain('Qualitätssicherung');
    expect(forceMessages()).toHaveLength(1); // greeting deferred

    // Notice turn completes → the greeting force_message follows, verbatim.
    serverSend({ type: 'response.created' });
    serverSend({ type: 'response.done' });
    await waitFor(() => (forceMessages().length === 2 ? true : undefined));
    expect(forceMessages()[1]!.item.content[0]?.text).toBe('Willkommen!');
    // Never a response.create — both turns are force_messages.
    expect(received.find((e) => e.type === 'response.create')).toBeUndefined();
  });

  // --- remote hangup finalization (2026-07-21 live evidence) -----------------------

  it('caller hangup (abnormal close, rejoin refused) finalizes as completed/remote_close', async () => {
    const fake = makeFakeSupabase();
    startSession(fake);
    await completeHandshake();
    await waitFor(() =>
      fake.updates.find((u) => u.table === 'voice_calls' && u.patch.status === 'active')
    );

    // Caller hangs up: xAI tears the socket down abnormally. Shut the mock
    // server down FIRST so the automatic rejoin is refused (an ended call).
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((r) => wss.close(() => r()));

    // rejoin happens after ~2s, its refusal closes the session → completed.
    const update = await waitFor(
      () =>
        fake.updates.find(
          (u) =>
            u.table === 'voice_calls' &&
            u.patch.status === 'completed' &&
            u.patch.ended_reason === 'remote_close'
        ),
      8000
    );
    expect(update).toBeDefined();
    // no failed/reconnect_failed finalization anywhere
    expect(
      fake.updates.find(
        (u) => u.table === 'voice_calls' && u.patch.ended_reason === 'reconnect_failed'
      )
    ).toBeUndefined();
  });
});
