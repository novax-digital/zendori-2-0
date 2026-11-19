import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { Logger, SupabaseClient } from '@zendori/core';
import { DemoCallSession } from '../src/demo/session.js';
import { buildDemoSessionConfig, DEMO_FAREWELL_TEXT, DEMO_TIMEOUT_TEXT } from '../src/demo/prompt.js';
import type { DemoToolResult } from '../src/demo/tools.js';

// Drives a real DemoCallSession against an in-process mock xAI WebSocket:
// greeting-first handshake (AI disclosure before the model's first turn),
// cumulative caller transcript, end_call → farewell → REST hangup, the
// max-duration watchdog and finalize into demo_calls.

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

function makeFakeSupabase() {
  const updates: { table: string; patch: Record<string, unknown> }[] = [];
  function builder() {
    const self: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
          }
          return () => self;
        },
      }
    );
    return self;
  }
  const client = {
    from(table: string) {
      return {
        update(patch: Record<string, unknown>) {
          updates.push({ table, patch });
          return builder();
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, updates };
}

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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), method: init?.method ?? 'GET' });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
});

const GREETING = 'Guten Tag, hier ist der KI-Telefonassistent von Testfirma.';

function startSession(
  fake: ReturnType<typeof makeFakeSupabase>,
  overrides: {
    maxCallSeconds?: number;
    runTool?: (name: string, rawArgs: string) => Promise<DemoToolResult>;
  } = {}
): DemoCallSession {
  const maxCallSeconds = overrides.maxCallSeconds ?? 240;
  const session = new DemoCallSession({
    supabase: fake.client,
    logger: silentLogger,
    apiKey: 'test-key',
    demoCallId: '00000000-0000-4000-8000-000000000001',
    providerCallId: 'call-demo',
    sessionConfig: buildDemoSessionConfig(
      { company: 'Testfirma', contactName: 'Anna', prompt: '', websiteSummary: null, maxCallSeconds },
      { voice: 'eve' }
    ),
    greeting: GREETING,
    maxCallSeconds,
    ...(overrides.runTool ? { runTool: overrides.runTool } : {}),
    onClosed: () => undefined,
    wsUrl: `ws://127.0.0.1:${port}`,
    hangupGraceMs: 30,
    greetFallbackMs: 2_000,
  });
  session.start();
  return session;
}

/** Text of the force_message frames the session sent, in order. */
function forcedTexts(): string[] {
  return received
    .filter((e) => e.type === 'conversation.item.create')
    .map((e) => (e as { item?: { type?: string; content?: { text?: string }[] } }).item)
    .filter((item) => item?.type === 'force_message')
    .map((item) => item?.content?.[0]?.text ?? '');
}

async function handshake(): Promise<void> {
  await waitFor(() => received.find((e) => e.type === 'session.update'));
  serverSend({ type: 'session.updated' });
  await waitFor(() => (forcedTexts().includes(GREETING) ? true : undefined));
}

describe('DemoCallSession', () => {
  it('speaks the AI disclosure first and requests the first model turn only after it', async () => {
    const fake = makeFakeSupabase();
    startSession(fake);
    await handshake();

    // no response.create while the greeting force_message is playing
    expect(received.some((e) => e.type === 'response.create')).toBe(false);
    const greetingFrame = received.find((e) => e.type === 'conversation.item.create') as {
      item: { interruptible: boolean };
    };
    expect(greetingFrame.item.interruptible).toBe(false);

    serverSend({ type: 'response.created' });
    serverSend({ type: 'response.output_audio_transcript.delta', delta: GREETING });
    serverSend({ type: 'response.done' });
    await waitFor(() => received.find((e) => e.type === 'response.create'));

    // demo row flipped to in_call
    await waitFor(() =>
      fake.updates.find((u) => u.table === 'demo_calls' && u.patch.status === 'in_call')
    );
  });

  it('keeps only the latest cumulative caller transcript and ends via end_call with the fixed farewell', async () => {
    const fake = makeFakeSupabase();
    const session = startSession(fake);
    await handshake();
    serverSend({ type: 'response.created' });
    serverSend({ type: 'response.output_audio_transcript.delta', delta: GREETING });
    serverSend({ type: 'response.done' });
    await waitFor(() => received.find((e) => e.type === 'response.create'));

    // cumulative ASR: "Ja" → "Ja, hier" → "Ja, hier ist Anna"
    serverSend({ type: 'conversation.item.input_audio_transcription.updated', item_id: 'u1', transcript: 'Ja' });
    serverSend({ type: 'conversation.item.input_audio_transcription.updated', item_id: 'u1', transcript: 'Ja, hier' });
    serverSend({
      type: 'conversation.item.input_audio_transcription.updated',
      item_id: 'u1',
      transcript: 'Ja, hier ist Anna',
    });
    serverSend({ type: 'response.created' });
    serverSend({ type: 'response.output_audio_transcript.delta', delta: 'Schön, ' });
    serverSend({ type: 'response.output_audio_transcript.delta', delta: 'danke für Ihre Zeit.' });
    serverSend({ type: 'response.function_call_arguments.done', call_id: 'fc1', name: 'end_call', arguments: '{}' });
    serverSend({ type: 'response.done' });

    await waitFor(() => (forcedTexts().includes(DEMO_FAREWELL_TEXT) ? true : undefined));
    await waitFor(() => fetchCalls.find((c) => c.url.endsWith('/v1/realtime/calls/call-demo/hangup')));
    const output = received.find((e) => e.type === 'conversation.item.create' && (e as { item?: { type?: string } }).item?.type === 'function_call_output');
    expect(output).toBeDefined();

    expect(session.transcript().map((t) => [t.role, t.text])).toEqual([
      ['assistant', GREETING],
      ['caller', 'Ja, hier ist Anna'],
      ['assistant', 'Schön, danke für Ihre Zeit.'],
    ]);

    // remote close after hangup → finalized as completed with the transcript
    serverSocket?.close(1000);
    const final = await waitFor(() =>
      fake.updates.find((u) => u.table === 'demo_calls' && u.patch.status === 'completed')
    );
    expect(final.patch.status_detail).toBe('agent_end');
    expect(Array.isArray(final.patch.transcript)).toBe(true);
    expect(typeof final.patch.duration_seconds).toBe('number');
  });

  it('runs an action tool, answers the model, records the action and lets the call go on', async () => {
    const fake = makeFakeSupabase();
    const toolCalls: { name: string; rawArgs: string }[] = [];
    const session = startSession(fake, {
      runTool: async (name, rawArgs) => {
        toolCalls.push({ name, rawArgs });
        return {
          output: { ok: true, ticket_id: 'DEMO-4821' },
          turn: { role: 'action', kind: 'ticket', text: 'Ticket DEMO-4821 aufgenommen', at: 'now' },
        };
      },
    });
    await handshake();
    serverSend({ type: 'response.created' });
    serverSend({ type: 'response.output_audio_transcript.delta', delta: GREETING });
    serverSend({ type: 'response.done' });
    await waitFor(() => received.find((e) => e.type === 'response.create'));
    const createsBefore = received.filter((e) => e.type === 'response.create').length;

    serverSend({ type: 'response.created' });
    serverSend({ type: 'response.output_audio_transcript.delta', delta: 'Ich nehme das auf.' });
    serverSend({
      type: 'response.function_call_arguments.done',
      call_id: 'fc-ticket',
      name: 'create_ticket',
      arguments: '{"subject":"Heizung","description":"Fällt aus."}',
    });
    serverSend({ type: 'response.done' });

    const output = await waitFor(() =>
      received
        .map((e) => (e as { item?: { type?: string; call_id?: string; output?: string } }).item)
        .find((item) => item?.type === 'function_call_output' && item.call_id === 'fc-ticket')
    );
    expect(JSON.parse(output.output ?? '{}')).toEqual({ ok: true, ticket_id: 'DEMO-4821' });
    expect(toolCalls).toEqual([
      { name: 'create_ticket', rawArgs: '{"subject":"Heizung","description":"Fällt aus."}' },
    ]);
    // the model gets its next turn — no farewell, no hangup
    await waitFor(() =>
      received.filter((e) => e.type === 'response.create').length > createsBefore ? true : undefined
    );
    expect(forcedTexts()).not.toContain(DEMO_FAREWELL_TEXT);
    expect(session.transcript().map((t) => [t.role, t.text])).toEqual([
      ['assistant', GREETING],
      ['assistant', 'Ich nehme das auf.'],
      ['action', 'Ticket DEMO-4821 aufgenommen'],
    ]);
    const persisted = fake.updates.filter((u) => Array.isArray(u.patch.transcript)).at(-1);
    expect((persisted?.patch.transcript as { role: string }[]).map((t) => t.role)).toContain('action');
    serverSocket?.close(1000);
    await session.closed;
  });

  it('answers a tool call with a failure when the tool throws, and keeps the call alive', async () => {
    const fake = makeFakeSupabase();
    const session = startSession(fake, {
      runTool: async () => {
        throw new Error('provider down');
      },
    });
    await handshake();
    serverSend({ type: 'response.created' });
    serverSend({ type: 'response.function_call_arguments.done', call_id: 'fc-sms', name: 'send_sms', arguments: '{"text":"Hallo"}' });
    serverSend({ type: 'response.done' });
    const output = await waitFor(() =>
      received
        .map((e) => (e as { item?: { type?: string; call_id?: string; output?: string } }).item)
        .find((item) => item?.type === 'function_call_output' && item.call_id === 'fc-sms')
    );
    expect(JSON.parse(output.output ?? '{}')).toMatchObject({ ok: false, error: 'failed' });
    expect(session.transcript().some((t) => t.role === 'action')).toBe(false);
    serverSocket?.close(1000);
    await session.closed;
  });

  it('fails the row when the WebSocket closes before the session became active', async () => {
    const fake = makeFakeSupabase();
    startSession(fake);
    await waitFor(() => received.find((e) => e.type === 'session.update'));
    serverSocket?.close(1011);
    const final = await waitFor(() =>
      fake.updates.find((u) => u.table === 'demo_calls' && u.patch.status === 'failed')
    );
    expect(final.patch.status_detail).toBe('connect_failed');
  });

  it('ends the call with the timeout notice when the demo time is up', async () => {
    const fake = makeFakeSupabase();
    // maxCallSeconds is validated ≥60 in env; the session itself just uses it
    const session = new DemoCallSession({
      supabase: fake.client,
      logger: silentLogger,
      apiKey: 'test-key',
      demoCallId: '00000000-0000-4000-8000-000000000002',
      providerCallId: 'call-timeout',
      sessionConfig: buildDemoSessionConfig(
        { company: 'Testfirma', contactName: 'Anna', prompt: '', websiteSummary: null, maxCallSeconds: 60 },
        { voice: 'eve' }
      ),
      greeting: GREETING,
      maxCallSeconds: 0.2,
      onClosed: () => undefined,
      wsUrl: `ws://127.0.0.1:${port}`,
      hangupGraceMs: 30,
      greetFallbackMs: 2_000,
    });
    session.start();
    await handshake();
    await waitFor(() => (forcedTexts().includes(DEMO_TIMEOUT_TEXT) ? true : undefined));
    await waitFor(() => fetchCalls.find((c) => c.url.endsWith('/v1/realtime/calls/call-timeout/hangup')));
  });
});
