import { describe, expect, it } from 'vitest';
import {
  MCP_CALL_MAX_RESPONSE_BYTES,
  MCP_CLIENT_PROTOCOL_VERSION,
  McpError,
  mcpCallTool,
  mcpListTools,
  type McpEndpoint,
} from '../src/index.js';

// The MCP client against a scripted server (injected fetch — no network). These
// tests pin the wire behaviour and the safety properties: no redirects, no
// retries, a hard size and time budget, and protocol headers a connection's
// credentials can never replace. Interop with a real server implementation is
// covered by packages/mcp-interop.

interface Recorded {
  method: string;
  headers: Headers;
  /** Parsed JSON-RPC message of a POST, null for DELETE. */
  rpc: { id?: number; method: string; params?: Record<string, unknown> } | null;
}

type Reply = (rpc: NonNullable<Recorded['rpc']>, recorded: Recorded[]) => Response | undefined;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function ok(id: number | undefined, result: unknown): Response {
  return json({ jsonrpc: '2.0', id, result });
}

/** An SSE response delivered in exactly the given chunks. */
function sse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    ...init,
    headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) },
  });
}

const TOOL = {
  name: 'get_order',
  description: 'Liefert eine Bestellung.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

/**
 * A scripted MCP server. `reply` may override the answer to any request; what
 * it leaves undefined gets the default behaviour (a stateful JSON server).
 */
function server(recorded: Recorded[], reply: Reply = () => undefined): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    if (method !== 'POST') {
      recorded.push({ method, headers, rpc: null });
      return new Response(null, { status: 200 });
    }
    const rpc = JSON.parse(String(init?.body)) as NonNullable<Recorded['rpc']>;
    recorded.push({ method, headers, rpc });
    const custom = reply(rpc, recorded);
    if (custom) return custom;
    switch (rpc.method) {
      case 'initialize':
        return json(
          {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'shop', version: '1.2.0' },
            },
          },
          { headers: { 'mcp-session-id': 'sess-1' } }
        );
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list':
        return ok(rpc.id, { tools: [TOOL] });
      case 'tools/call':
        return ok(rpc.id, { content: [{ type: 'text', text: 'ok' }] });
      default:
        return json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'nope' } });
    }
  }) as typeof fetch;
}

function endpoint(fetchImpl: typeof fetch, overrides: Partial<McpEndpoint> = {}): McpEndpoint {
  return {
    url: 'https://mcp.example.com/mcp',
    auth: { kind: 'bearer', secret: 'tok' },
    timeoutMs: 2_000,
    fetchImpl,
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof McpError) return err;
    throw err;
  }
  throw new Error('expected the call to fail');
}

/** Lets the fire-and-forget session DELETE of mcpCallTool land. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('mcpListTools', () => {
  it('runs the handshake, lists the tools and closes the session', async () => {
    const recorded: Recorded[] = [];
    const list = await mcpListTools(endpoint(server(recorded)));

    expect(list.server).toEqual({ name: 'shop', version: '1.2.0', protocolVersion: '2025-06-18' });
    expect(list.tools).toEqual([
      {
        name: 'get_order',
        title: null,
        description: 'Liefert eine Bestellung.',
        inputSchema: TOOL.inputSchema,
        readOnlyHint: null,
        destructiveHint: null,
      },
    ]);
    expect(list).toMatchObject({ truncated: false, skipped: 0 });

    expect(recorded.map((r) => r.rpc?.method ?? r.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'DELETE',
    ]);
    expect(recorded[0]?.rpc?.params).toEqual({
      protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'zendori', version: '1.0.0' },
    });
    // a notification carries no id
    expect(recorded[1]?.rpc && 'id' in recorded[1].rpc).toBe(false);
    for (const request of recorded) {
      expect(request.headers.get('authorization')).toBe('Bearer tok');
      expect(request.headers.get('accept')).toBe('application/json, text/event-stream');
    }
    // nothing is known before the server answered initialize
    expect(recorded[0]?.headers.get('mcp-session-id')).toBeNull();
    expect(recorded[0]?.headers.get('mcp-protocol-version')).toBeNull();
    for (const request of recorded.slice(1)) {
      expect(request.headers.get('mcp-session-id')).toBe('sess-1');
      expect(request.headers.get('mcp-protocol-version')).toBe('2025-06-18');
    }
  });

  it('speaks the revision the server chose and sends no DELETE without a session', async () => {
    const recorded: Recorded[] = [];
    const list = await mcpListTools(
      endpoint(
        server(recorded, (rpc) =>
          rpc.method === 'initialize'
            ? ok(rpc.id, { protocolVersion: '2025-03-26', serverInfo: {} })
            : undefined
        )
      )
    );
    expect(list.server).toEqual({ name: '', version: '', protocolVersion: '2025-03-26' });
    expect(recorded.map((r) => r.method)).toEqual(['POST', 'POST', 'POST']);
    expect(recorded[2]?.headers.get('mcp-protocol-version')).toBe('2025-03-26');
    expect(recorded[2]?.headers.get('mcp-session-id')).toBeNull();
  });

  it('follows cursors, skips broken entries and duplicates, and reads annotations', async () => {
    const recorded: Recorded[] = [];
    const list = await mcpListTools(
      endpoint(
        server(recorded, (rpc) => {
          if (rpc.method !== 'tools/list') return undefined;
          if (!rpc.params?.cursor) {
            return ok(rpc.id, {
              tools: [
                TOOL,
                { description: 'no name' },
                'garbage',
                { ...TOOL, name: 'get_order' },
                { name: 'bare' },
              ],
              nextCursor: 'page-2',
            });
          }
          return ok(rpc.id, {
            tools: [
              {
                name: 'cancel_order',
                title: 'Bestellung stornieren',
                description: null,
                inputSchema: { type: 'object' },
                annotations: { readOnlyHint: false, destructiveHint: true, title: 'ignored' },
              },
              { name: 'lookup', annotations: { readOnlyHint: true, title: 'Nachschlagen' } },
              { name: 'odd', annotations: { readOnlyHint: 'yes' } },
            ],
          });
        })
      )
    );
    expect(
      recorded.filter((r) => r.rpc?.method === 'tools/list').map((r) => r.rpc?.params)
    ).toEqual([{}, { cursor: 'page-2' }]);
    expect(list.skipped).toBe(3);
    expect(list.tools.map((t) => [t.name, t.title, t.readOnlyHint, t.destructiveHint])).toEqual([
      ['get_order', null, null, null],
      ['bare', null, null, null],
      ['cancel_order', 'Bestellung stornieren', false, true],
      ['lookup', 'Nachschlagen', true, null],
      ['odd', null, null, null],
    ]);
    // a tool without a schema takes no arguments
    expect(list.tools[1]?.inputSchema).toEqual({ type: 'object', properties: {} });
    expect(list.tools[1]?.description).toBe('');
  });

  it('stops at maxTools and says so', async () => {
    const tools = Array.from({ length: 5 }, (_, i) => ({ name: `tool_${i}` }));
    const list = await mcpListTools(
      endpoint(
        server([], (rpc) => (rpc.method === 'tools/list' ? ok(rpc.id, { tools }) : undefined))
      ),
      { maxTools: 3 }
    );
    expect(list.tools.map((t) => t.name)).toEqual(['tool_0', 'tool_1', 'tool_2']);
    expect(list.truncated).toBe(true);
  });

  it('does not read pages forever', async () => {
    const recorded: Recorded[] = [];
    const list = await mcpListTools(
      endpoint(
        server(recorded, (rpc) =>
          rpc.method === 'tools/list'
            ? ok(rpc.id, { tools: [{ name: `t_${recorded.length}` }], nextCursor: 'more' })
            : undefined
        )
      )
    );
    expect(recorded.filter((r) => r.rpc?.method === 'tools/list')).toHaveLength(10);
    expect(list.truncated).toBe(true);
  });
});

describe('SSE responses', () => {
  it('finds the response among comments, keep-alives and server messages', async () => {
    const recorded: Recorded[] = [];
    const list = await mcpListTools(
      endpoint(
        server(recorded, (rpc) => {
          if (rpc.method !== 'tools/list') return undefined;
          const answer = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [TOOL] } });
          return sse([
            ': keep-alive\n\n',
            'id: 1\ndata: \n\n',
            `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })}\n\n`,
            // a request FROM the server that happens to reuse our id — not our answer
            `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, method: 'ping' })}\n\n`,
            'data: {not json}\n\n',
            `event: message\nid: 2\ndata: ${answer}\n\n`,
          ]);
        })
      )
    );
    expect(list.tools.map((t) => t.name)).toEqual(['get_order']);
  });

  it('handles CRLF, chunk borders inside a line and inside a CRLF, and multi-line data', async () => {
    const list = await mcpListTools(
      endpoint(
        server([], (rpc) => {
          if (rpc.method !== 'tools/list') return undefined;
          // the JSON is split over two data lines (joined with a newline)
          const first = `{"jsonrpc":"2.0","id":${rpc.id},`;
          const second = `"result":{"tools":[{"name":"crlf_tool"}]}}`;
          return sse(['event: mess', 'age\r', `\ndata: ${first}\r\ndata:${second}\r`, '\n\r\n']);
        })
      )
    );
    expect(list.tools.map((t) => t.name)).toEqual(['crlf_tool']);
  });

  it('accepts a final event without the closing blank line', async () => {
    const result = await mcpCallTool(
      endpoint(
        server([], (rpc) =>
          rpc.method === 'tools/call'
            ? sse([
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'ende' }] } })}`,
              ])
            : undefined
        )
      ),
      { name: 'get_order', arguments: {} }
    );
    expect(result.result.texts).toEqual(['ende']);
  });

  it('a stream that ends without our response is a protocol error', async () => {
    const error = await failure(
      mcpCallTool(
        endpoint(
          server([], (rpc) =>
            rpc.method === 'tools/call'
              ? sse([`data: ${JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} })}\n\n`])
              : undefined
          )
        ),
        { name: 'get_order', arguments: {} }
      )
    );
    expect(error.code).toBe('protocol_error');
  });

  it('caps an endless stream', async () => {
    const filler = `: ${'x'.repeat(64 * 1024)}\n\n`;
    const error = await failure(
      mcpCallTool(
        endpoint(
          server([], (rpc) =>
            rpc.method === 'tools/call' ? sse(Array.from({ length: 8 }, () => filler)) : undefined
          )
        ),
        { name: 'get_order', arguments: {} }
      )
    );
    expect(error.code).toBe('response_too_large');
    expect(8 * filler.length).toBeGreaterThan(MCP_CALL_MAX_RESPONSE_BYTES);
  });
});

describe('mcpCallTool', () => {
  it('sends name and arguments once, with the run id as idempotency key', async () => {
    const recorded: Recorded[] = [];
    const { result, latencyMs } = await mcpCallTool(
      endpoint(
        server(recorded, (rpc) =>
          rpc.method === 'tools/call'
            ? ok(rpc.id, {
                content: [
                  { type: 'text', text: 'Bestellung 4711' },
                  { type: 'image', data: 'AAAA', mimeType: 'image/png' },
                  { type: 'resource', resource: { uri: 'file:///a', text: 'Anhangtext' } },
                  { type: 'resource', resource: { uri: 'file:///b', blob: 'AAAA' } },
                  'garbage',
                ],
                structuredContent: { status: 'shipped' },
              })
            : undefined
        ),
        {
          now: (() => {
            let t = 1_000;
            return () => (t += 40);
          })(),
        }
      ),
      { name: 'get_order', arguments: { id: '4711', nested: { a: 1 } }, requestId: 'run-1' }
    );
    await settle();

    expect(result).toEqual({
      texts: ['Bestellung 4711', 'Anhangtext'],
      otherBlocks: 3,
      structuredContent: { status: 'shipped' },
      isError: false,
    });
    expect(latencyMs).toBe(40);

    const calls = recorded.filter((r) => r.rpc?.method === 'tools/call');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.rpc?.params).toEqual({
      name: 'get_order',
      arguments: { id: '4711', nested: { a: 1 } },
    });
    expect(calls[0]?.headers.get('idempotency-key')).toBe('run-1');
    // only the call itself carries the key
    expect(recorded[0]?.headers.get('idempotency-key')).toBeNull();
    expect(recorded.map((r) => r.rpc?.method ?? r.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'DELETE',
    ]);
  });

  it('returns a result the tool marks as an error instead of throwing', async () => {
    const { result } = await mcpCallTool(
      endpoint(
        server([], (rpc) =>
          rpc.method === 'tools/call'
            ? ok(rpc.id, { content: [{ type: 'text', text: 'unbekannt' }], isError: true })
            : undefined
        )
      ),
      { name: 'get_order', arguments: {} }
    );
    expect(result).toEqual({
      texts: ['unbekannt'],
      otherBlocks: 0,
      structuredContent: null,
      isError: true,
    });
  });

  it('a JSON-RPC error becomes rpc_error with a bounded, single-line detail', async () => {
    const recorded: Recorded[] = [];
    const error = await failure(
      mcpCallTool(
        endpoint(
          server(recorded, (rpc) =>
            rpc.method === 'tools/call'
              ? json({
                  jsonrpc: '2.0',
                  id: rpc.id,
                  error: { code: -32602, message: `Unknown tool\n\u0000${'x'.repeat(900)}` },
                })
              : undefined
          )
        ),
        { name: 'nope', arguments: {} }
      )
    );
    expect(error.code).toBe('rpc_error');
    expect(error.rpcCode).toBe(-32602);
    expect(error.detail?.startsWith('Unknown tool x')).toBe(true);
    expect(error.detail).toHaveLength(300);
    // the code is all that is safe to log
    expect(error.message).toBe('mcp request failed (rpc_error)');
    // never retried
    expect(recorded.filter((r) => r.rpc?.method === 'tools/call')).toHaveLength(1);
  });

  it('accepts a legacy batch answer and an error with id null', async () => {
    const batch = await mcpCallTool(
      endpoint(
        server([], (rpc) =>
          rpc.method === 'tools/call'
            ? json([
                { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
                { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'b' }] } },
              ])
            : undefined
        )
      ),
      { name: 'get_order', arguments: {} }
    );
    expect(batch.result.texts).toEqual(['b']);

    const error = await failure(
      mcpCallTool(
        endpoint(
          server([], (rpc) =>
            rpc.method === 'tools/call'
              ? json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
              : undefined
          )
        ),
        { name: 'get_order', arguments: {} }
      )
    );
    expect([error.code, error.rpcCode, error.detail]).toEqual(['rpc_error', -32700, 'Parse error']);
  });
});

describe('failures and limits', () => {
  it('reports an HTTP error with the status and what the server said', async () => {
    const recorded: Recorded[] = [];
    const error = await failure(
      mcpListTools(
        endpoint(
          server(recorded, (rpc) =>
            rpc.method === 'initialize'
              ? json(
                  { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid token' } },
                  { status: 401 }
                )
              : undefined
          )
        )
      )
    );
    expect([error.code, error.httpStatus, error.detail]).toEqual([
      'http_error',
      401,
      'Invalid token',
    ]);
    expect(recorded).toHaveLength(1);

    const plain = await failure(
      mcpListTools(
        endpoint(server([], () => new Response('<h1>Bad\ngateway</h1>', { status: 502 })))
      )
    );
    expect([plain.code, plain.httpStatus, plain.detail]).toEqual([
      'http_error',
      502,
      '<h1>Bad gateway</h1>',
    ]);
  });

  it('never follows a redirect', async () => {
    const recorded: Recorded[] = [];
    const error = await failure(
      mcpListTools(
        endpoint(
          server(
            recorded,
            () =>
              new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/' } })
          )
        )
      )
    );
    expect([error.code, error.httpStatus]).toEqual(['redirected', 307]);
    expect(recorded).toHaveLength(1);
  });

  it('asks the SSRF guard before every request and sends nothing when it refuses', async () => {
    const recorded: Recorded[] = [];
    let checks = 0;
    await mcpListTools(
      endpoint(server(recorded), {
        assertUrl: async (url) => {
          checks += 1;
          expect(url).toBe('https://mcp.example.com/mcp');
        },
      })
    );
    expect(checks).toBe(recorded.length);
    expect(checks).toBe(4);

    const blocked: Recorded[] = [];
    const error = await failure(
      mcpListTools(
        endpoint(server(blocked), {
          assertUrl: async () => {
            throw new Error('private address');
          },
        })
      )
    );
    expect(error.code).toBe('blocked_url');
    expect(blocked).toHaveLength(0);
  });

  it('a connection header can never replace a protocol header', async () => {
    const recorded: Recorded[] = [];
    await mcpListTools(
      endpoint(server(recorded), {
        auth: { kind: 'header', headerName: 'Accept', secret: 'text/html' },
      })
    );
    expect(
      recorded.every((r) => r.headers.get('accept') === 'application/json, text/event-stream')
    ).toBe(true);

    const session: Recorded[] = [];
    await mcpListTools(
      endpoint(server(session), {
        auth: { kind: 'header', headerName: 'Mcp-Session-Id', secret: 'forged' },
      })
    );
    expect(session[2]?.headers.get('mcp-session-id')).toBe('sess-1');
  });

  it('ignores a session id that is not plain visible ASCII', async () => {
    const recorded: Recorded[] = [];
    await mcpListTools(
      endpoint(
        server(recorded, (rpc) =>
          rpc.method === 'initialize'
            ? json(
                { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18' } },
                { headers: { 'mcp-session-id': 'has space' } }
              )
            : undefined
        )
      )
    );
    expect(recorded.every((r) => r.headers.get('mcp-session-id') === null)).toBe(true);
  });

  it('rejects an answer that is not MCP', async () => {
    const notRpc = await failure(
      mcpListTools(endpoint(server([], () => json({ hello: 'world' }))))
    );
    expect(notRpc.code).toBe('protocol_error');

    const html = await failure(
      mcpListTools(
        endpoint(
          server([], () => new Response('<html>', { headers: { 'content-type': 'text/html' } }))
        )
      )
    );
    expect(html.code).toBe('protocol_error');

    const badVersion = await failure(
      mcpListTools(
        endpoint(
          server([], (rpc) =>
            rpc.method === 'initialize' ? ok(rpc.id, { protocolVersion: 'latest' }) : undefined
          )
        )
      )
    );
    expect(badVersion.code).toBe('protocol_error');

    const badList = await failure(
      mcpListTools(
        endpoint(
          server([], (rpc) =>
            rpc.method === 'tools/list' ? ok(rpc.id, { tools: 'none' }) : undefined
          )
        )
      )
    );
    expect(badList.code).toBe('protocol_error');
  });

  it('a refused initialized notification stops the exchange', async () => {
    const recorded: Recorded[] = [];
    const error = await failure(
      mcpCallTool(
        endpoint(
          server(recorded, (rpc) =>
            rpc.method === 'notifications/initialized'
              ? new Response(null, { status: 400 })
              : undefined
          )
        ),
        { name: 'get_order', arguments: {} }
      )
    );
    expect([error.code, error.httpStatus]).toEqual(['http_error', 400]);
    expect(recorded.some((r) => r.rpc?.method === 'tools/call')).toBe(false);
  });

  it('caps a JSON answer by declared and by actual size', async () => {
    const declared = await failure(
      mcpCallTool(
        endpoint(
          server([], (rpc) =>
            rpc.method === 'tools/call'
              ? json({}, { headers: { 'content-length': String(MCP_CALL_MAX_RESPONSE_BYTES + 1) } })
              : undefined
          )
        ),
        { name: 'get_order', arguments: {} }
      )
    );
    expect(declared.code).toBe('response_too_large');

    const actual = await failure(
      mcpCallTool(
        endpoint(
          server([], (rpc) =>
            rpc.method === 'tools/call'
              ? ok(rpc.id, { content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] })
              : undefined
          )
        ),
        { name: 'get_order', arguments: {} }
      )
    );
    expect(actual.code).toBe('response_too_large');
  });

  it('gives up after the time budget — for the whole exchange', async () => {
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const error = await failure(
      mcpCallTool(endpoint(hanging, { timeoutMs: 30 }), { name: 'get_order', arguments: {} })
    );
    expect(error.code).toBe('timeout');

    // a body that never finishes counts against the same budget
    const slowBody = server([], (rpc) =>
      rpc.method === 'tools/call'
        ? new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { 'content-type': 'application/json' },
          })
        : undefined
    );
    const stalled = ((input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return slowBody(input, init).then((response) => {
        if (!response.body || !signal) return response;
        // tie the stream to the abort signal like a real network body
        const reader = response.body.getReader();
        const tied = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(new Error('aborted')));
            void reader.read().then(({ done, value }) => {
              if (done) controller.close();
              else controller.enqueue(value);
            });
          },
        });
        return new Response(tied, { status: response.status, headers: response.headers });
      });
    }) as typeof fetch;
    const bodyError = await failure(
      mcpCallTool(endpoint(stalled, { timeoutMs: 40 }), { name: 'get_order', arguments: {} })
    );
    expect(bodyError.code).toBe('timeout');
  });

  it('maps a transport failure to network', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const error = await failure(mcpListTools(endpoint(down)));
    expect(error.code).toBe('network');
  });
});
