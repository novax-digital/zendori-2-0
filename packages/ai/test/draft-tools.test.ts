import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Phase 13: the draft step may call data actions in a bounded tool loop. The
// Anthropic API is replaced by a local HTTP server (ANTHROPIC_API_BASE) that
// serves queued responses and records the request bodies — no real model call.

interface RecordedRequest {
  system: string;
  messages: { role: string; content: unknown }[];
  tools?: { name: string; description: string; input_schema: unknown }[];
  tool_choice?: { type: string };
  output_config?: unknown;
}

let server: Server;
const requests: RecordedRequest[] = [];
let queue: unknown[] = [];

function messageResponse(
  content: unknown[],
  stopReason: 'end_turn' | 'tool_use',
  usage = { input_tokens: 100, output_tokens: 20 }
): unknown {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

const text = (value: string) => ({ type: 'text', text: value });
const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const FINAL = text(
  '{"reply": "Ihre Bestellung ist unterwegs.", "confidence": 0.92, "used_source_ids": []}'
);

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      requests.push(JSON.parse(body) as RecordedRequest);
      const next = queue.shift();
      res.writeHead(next ? 200 : 500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          next ?? { type: 'error', error: { type: 'api_error', message: 'empty queue' } }
        )
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_API_BASE = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
  queue = [];
});

const { draft, DRAFT_MAX_TOOL_CALLS, DRAFT_MAX_TOOL_ROUNDS } = await import('../src/anthropic.js');

const BASE_INPUT = {
  companyName: 'Acme GmbH',
  channelType: 'chat',
  body: 'Wo ist meine Bestellung 4711?',
  sources: [],
};

const ORDER_TOOL = {
  name: 'bestellstatus',
  description: 'Liefert den Status einer Bestellung.',
  inputSchema: {
    type: 'object' as const,
    properties: { order_id: { type: 'string' } },
    required: ['order_id'],
  },
};

describe('the draft envelope', () => {
  // Measured against the real API on 2026-11-26: with the envelope enforced as a
  // structured output, a quotation the model closes with a straight quote —
  // „Hörprobe" — ends the reply string, and the rest of the answer is lost
  // behind valid JSON. The envelope is asked for in the prompt and parsed here.
  it('is not enforced by the API: that would cut the reply at the first quote', async () => {
    queue = [messageResponse([FINAL], 'end_turn')];
    await draft(BASE_INPUT);
    queue = [
      messageResponse([toolUse('tu_1', 'bestellstatus', { order_id: '4711' })], 'tool_use'),
      messageResponse([FINAL], 'end_turn'),
    ];
    await draft({ ...BASE_INPUT, tools: [ORDER_TOOL], runTool: async () => ({ ok: true }) });

    expect(requests).toHaveLength(3);
    for (const request of requests) expect(request.output_config).toBeUndefined();
  });

  it('never hands out the raw envelope when the answer is not valid JSON', async () => {
    queue = [
      messageResponse(
        [
          text(
            '{"reply": "Klicke auf den „Hörprobe"-Knopf.", "confidence": 0.95, "used_source_ids": ["kb-1"]}'
          ),
        ],
        'end_turn'
      ),
    ];
    const recovered = await draft(BASE_INPUT);
    expect(recovered.result).toEqual({
      reply: 'Klicke auf den „Hörprobe"-Knopf.',
      confidence: 0.95,
      used_source_ids: ['kb-1'],
    });

    queue = [messageResponse([text('{"antwort": "Klicke auf „Start"."}')], 'end_turn')];
    const unreadable = await draft(BASE_INPUT);
    expect(unreadable.result.reply).not.toContain('{');
    expect(unreadable.result.confidence).toBe(0);
  });
});

describe('draft without tools', () => {
  it('is a single request without tool fields or action rules', async () => {
    queue = [messageResponse([FINAL], 'end_turn')];
    const result = await draft(BASE_INPUT);
    expect(result.toolCalls).toBe(0);
    expect(result.result.reply).toBe('Ihre Bestellung ist unterwegs.');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toBeUndefined();
    expect(requests[0]?.system).not.toContain('## Aktionen');
  });

  it('ignores tools when no executor is given', async () => {
    queue = [messageResponse([FINAL], 'end_turn')];
    await draft({ ...BASE_INPUT, tools: [ORDER_TOOL] });
    expect(requests[0]?.tools).toBeUndefined();
  });
});

describe('draft with data actions', () => {
  it('runs the tool, feeds the result back and sums usage over both round trips', async () => {
    queue = [
      messageResponse([toolUse('tu_1', 'bestellstatus', { order_id: '4711' })], 'tool_use', {
        input_tokens: 100,
        output_tokens: 20,
      }),
      messageResponse([FINAL], 'end_turn', { input_tokens: 150, output_tokens: 30 }),
    ];
    const calls: unknown[] = [];
    const result = await draft({
      ...BASE_INPUT,
      tools: [ORDER_TOOL],
      runTool: async (call) => {
        calls.push(call);
        return { ok: true, data: { status: 'shipped' } };
      },
    });

    expect(calls).toEqual([{ name: 'bestellstatus', input: { order_id: '4711' } }]);
    expect(result.toolCalls).toBe(1);
    expect(result.result.confidence).toBe(0.92);
    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 50 });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools?.[0]).toEqual({
      name: 'bestellstatus',
      description: 'Liefert den Status einer Bestellung.',
      input_schema: ORDER_TOOL.inputSchema,
    });
    expect(requests[0]?.system).toContain('## Aktionen');
    // second request: assistant turn echoed, then ONE user message with the result
    const second = requests[1]?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[2]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: JSON.stringify({ ok: true, data: { status: 'shipped' } }),
      },
    ]);
  });

  it('answers several tool calls of one turn in a single user message', async () => {
    queue = [
      messageResponse(
        [
          toolUse('tu_1', 'bestellstatus', { order_id: '1' }),
          toolUse('tu_2', 'bestellstatus', { order_id: '2' }),
        ],
        'tool_use'
      ),
      messageResponse([FINAL], 'end_turn'),
    ];
    const result = await draft({
      ...BASE_INPUT,
      tools: [ORDER_TOOL],
      runTool: async (call) => ({ ok: true, data: call.input }),
    });
    expect(result.toolCalls).toBe(2);
    const toolResults = requests[1]?.messages[2]?.content as { tool_use_id: string }[];
    expect(toolResults.map((r) => r.tool_use_id)).toEqual(['tu_1', 'tu_2']);
  });

  it('reports a throwing executor to the model as a failed tool call', async () => {
    queue = [
      messageResponse([toolUse('tu_1', 'bestellstatus', { order_id: '1' })], 'tool_use'),
      messageResponse([FINAL], 'end_turn'),
    ];
    await draft({
      ...BASE_INPUT,
      tools: [ORDER_TOOL],
      runTool: async () => {
        throw new Error('boom with secret detail');
      },
    });
    const toolResults = requests[1]?.messages[2]?.content as {
      is_error?: boolean;
      content: string;
    }[];
    expect(toolResults[0]?.is_error).toBe(true);
    expect(toolResults[0]?.content).not.toContain('secret detail');
  });

  it('forces an answer after the last tool round and caps the executed calls', async () => {
    // a model that never stops calling: two calls per round
    const stuck = () =>
      messageResponse(
        [
          toolUse(`tu_${Math.random()}`, 'bestellstatus', {}),
          toolUse(`tu_${Math.random()}`, 'bestellstatus', {}),
        ],
        'tool_use'
      );
    queue = [
      ...Array.from({ length: DRAFT_MAX_TOOL_ROUNDS }, stuck),
      messageResponse([], 'end_turn'),
    ];
    let executed = 0;
    const result = await draft({
      ...BASE_INPUT,
      language: 'de',
      tools: [ORDER_TOOL],
      runTool: async () => {
        executed += 1;
        return { ok: true };
      },
    });

    expect(requests).toHaveLength(DRAFT_MAX_TOOL_ROUNDS + 1);
    expect(executed).toBe(DRAFT_MAX_TOOL_CALLS);
    expect(result.toolCalls).toBe(DRAFT_MAX_TOOL_CALLS);
    // the final request keeps the tools declared but forbids calling them
    const last = requests[requests.length - 1];
    expect(last?.tool_choice).toEqual({ type: 'none' });
    expect(last?.tools).toHaveLength(1);
    expect(requests[0]?.tool_choice).toBeUndefined();
    // no answer text → a safe apology that can never auto-send
    expect(result.result.confidence).toBe(0);
    expect(result.result.reply.length).toBeGreaterThan(10);
  });
});
