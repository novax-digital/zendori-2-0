import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  buildActionArguments,
  coerceActionValues,
  draftActionFromMcpTool,
  mapMcpToolResult,
  toCatalogTool,
} from '@zendori/core';
import { McpError, mcpCallTool, mcpListTools, type McpEndpoint } from '@zendori/integrations';

// Interop: the hand-written MCP client (packages/integrations/src/mcp/client.ts)
// against a REAL MCP server built with the official SDK, over real HTTP on
// 127.0.0.1 — in all four server configurations a customer may run (with/without
// sessions, JSON or SSE answers).
//
// This test lives in a package of its own: nothing depends on @zendori/mcp-interop,
// so the SDK (and Express, Hono, … behind it) is never installed into the worker
// image. The scripted tests next to the client (mcp-client.test.ts) prove edge
// cases; this file proves that the protocol as we speak it is the protocol a
// real server understands.

function buildServer(): McpServer {
  const server = new McpServer({ name: 'reference-shop', version: '9.9.9' });

  server.registerTool(
    'getOrder',
    {
      title: 'Bestellung abrufen',
      description: 'Liefert Status und Positionen einer Bestellung.',
      inputSchema: {
        orderId: z.string().describe('Bestellnummer'),
        includeItems: z.boolean().optional(),
      },
      outputSchema: { status: z.string(), orderId: z.string(), internalNote: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ orderId }) => {
      const data = { status: 'shipped', orderId, internalNote: 'nicht für Kunden' };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    }
  );

  server.registerTool(
    'book',
    {
      description: 'Bucht einen Termin für einen Kunden.',
      inputSchema: {
        customer: z.object({ email: z.string(), name: z.string().optional() }),
        slot: z.enum(['morning', 'evening']),
        note: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async (args) => ({
      content: [
        {
          type: 'text',
          text: `gebucht: ${args.customer.email} / ${args.slot} / ${String(args.note)}`,
        },
      ],
    })
  );

  server.registerTool('fail', { description: 'Meldet immer einen Fehler.' }, async () => ({
    content: [{ type: 'text', text: 'Bestellung unbekannt' }],
    isError: true,
  }));

  server.registerTool('boom', { description: 'Wirft eine Ausnahme.' }, async () => {
    throw new Error('exploded');
  });

  return server;
}

interface Running {
  url: string;
  /** Session ids the server saw being closed with DELETE. */
  closed: string[];
  stop: () => Promise<void>;
}

async function start(mode: { stateful: boolean; json: boolean }): Promise<Running> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const closed: string[] = [];

  const httpServer: Server = createServer((req, res) => {
    void (async () => {
      if (req.url === '/redirect') {
        res.writeHead(307, { location: '/mcp' }).end();
        return;
      }
      if (req.headers.authorization !== 'Bearer secret') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32001, message: 'Unauthorized' },
          })
        );
        return;
      }

      if (!mode.stateful) {
        // stateless: a fresh server + transport per request
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: mode.json,
        });
        const server = buildServer();
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
      if (!transport) {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: mode.json,
          onsessioninitialized: (id) => {
            transports.set(id, created);
          },
          onsessionclosed: (id) => {
            transports.delete(id);
            closed.push(id);
          },
        });
        await buildServer().connect(created);
        transport = created;
      }
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    closed,
    stop: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
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

const MODES = [
  { name: 'sessions + SSE answers (SDK default)', stateful: true, json: false },
  { name: 'sessions + JSON answers', stateful: true, json: true },
  { name: 'stateless + SSE answers', stateful: false, json: false },
  { name: 'stateless + JSON answers', stateful: false, json: true },
];

describe.each(MODES)('real MCP server — $name', (mode) => {
  let running: Running;
  const endpoint = (overrides: Partial<McpEndpoint> = {}): McpEndpoint => ({
    url: running.url,
    auth: { kind: 'bearer', secret: 'secret' },
    timeoutMs: 5_000,
    ...overrides,
  });

  beforeAll(async () => {
    running = await start(mode);
  });
  afterAll(async () => {
    await running.stop();
  });

  it('reads the tool list and turns it into importable actions', async () => {
    const list = await mcpListTools(endpoint());
    expect(list.server.name).toBe('reference-shop');
    expect(list.server.version).toBe('9.9.9');
    expect(list.server.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(list.tools.map((tool) => tool.name).sort()).toEqual([
      'book',
      'boom',
      'fail',
      'getOrder',
    ]);
    expect(list).toMatchObject({ truncated: false, skipped: 0 });

    const getOrder = list.tools.find((tool) => tool.name === 'getOrder');
    expect(getOrder).toMatchObject({
      title: 'Bestellung abrufen',
      description: 'Liefert Status und Positionen einer Bestellung.',
      readOnlyHint: true,
    });

    // the schema the SDK generates from zod converts into our parameter model
    const drafted = getOrder ? draftActionFromMcpTool(toCatalogTool(getOrder), []) : null;
    expect(drafted).toMatchObject({
      ok: true,
      draft: { name: 'get_order', kind: 'read', requiresConfirmation: false, dropped: [] },
    });
    expect(
      drafted?.ok && drafted.draft.parameters.map((p) => [p.key, p.field, p.type, p.required])
    ).toEqual([
      ['order_id', 'orderId', 'string', true],
      ['include_items', 'includeItems', 'boolean', false],
    ]);

    const book = list.tools.find((tool) => tool.name === 'book');
    const bookDraft = book ? draftActionFromMcpTool(toCatalogTool(book), []) : null;
    expect(bookDraft).toMatchObject({
      ok: true,
      // no read-only hint → cautious default; the list argument is left out
      draft: { name: 'book', kind: 'write', requiresConfirmation: true, dropped: ['tags'] },
    });
    expect(
      bookDraft?.ok && bookDraft.draft.parameters.map((p) => [p.key, p.field ?? p.key, p.required])
    ).toEqual([
      ['customer_email', 'customer.email', true],
      ['customer_name', 'customer.name', false],
      ['slot', 'slot', true],
      ['note', 'note', false],
    ]);
    expect(bookDraft?.ok && bookDraft.draft.parameters[2]?.options).toEqual(['morning', 'evening']);

    if (mode.stateful) {
      // mcpListTools waits for its DELETE — the server saw the session end
      expect(running.closed).toHaveLength(1);
    }
  });

  it('calls a tool and gets structured content through the allowlist', async () => {
    const { result, latencyMs } = await mcpCallTool(endpoint(), {
      name: 'getOrder',
      arguments: { orderId: '4711' },
      requestId: 'run-1',
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      status: 'shipped',
      orderId: '4711',
      internalNote: 'nicht für Kunden',
    });
    expect(latencyMs).toBeGreaterThanOrEqual(0);
    expect(mapMcpToolResult(result, ['status', 'orderId'])).toEqual({
      isError: false,
      value: { status: 'shipped', orderId: '4711' },
    });
  });

  it('the server accepts the argument object Zendori builds from an imported tool', async () => {
    const list = await mcpListTools(endpoint());
    const book = list.tools.find((tool) => tool.name === 'book');
    const drafted = book ? draftActionFromMcpTool(toCatalogTool(book), []) : null;
    if (!drafted?.ok) throw new Error('book must be importable');
    const values = coerceActionValues(drafted.draft.parameters, {
      customer_email: 'kai@example.com',
      slot: 'evening',
    });
    if (!values.ok) throw new Error('values must validate');
    const args = buildActionArguments(drafted.draft.parameters, values.values);
    expect(args).toEqual({ customer: { email: 'kai@example.com' }, slot: 'evening' });

    const { result } = await mcpCallTool(endpoint(), { name: 'book', arguments: args });
    expect(result).toMatchObject({
      isError: false,
      texts: ['gebucht: kai@example.com / evening / undefined'],
    });
  });

  it('a tool that reports an error is a result, not a transport failure', async () => {
    const { result } = await mcpCallTool(endpoint(), { name: 'fail', arguments: {} });
    expect(result).toMatchObject({ isError: true, texts: ['Bestellung unbekannt'] });

    const thrown = await mcpCallTool(endpoint(), { name: 'boom', arguments: {} });
    expect(thrown.result.isError).toBe(true);
    expect(thrown.result.texts.join(' ')).toContain('exploded');
  });

  it('an unknown tool and invalid arguments come back as failures', async () => {
    for (const call of [
      { name: 'does_not_exist', arguments: {} },
      { name: 'getOrder', arguments: { orderId: 4711 } },
    ]) {
      // the server may answer with a JSON-RPC error or with an error result
      let failed = false;
      try {
        const { result } = await mcpCallTool(endpoint(), call);
        failed = result.isError;
      } catch (err) {
        if (!(err instanceof McpError)) throw err;
        expect(err.code).toBe('rpc_error');
        failed = true;
      }
      expect(failed).toBe(true);
    }
  });

  it('wrong credentials are an HTTP error with the status', async () => {
    const error = await failure(
      mcpListTools(endpoint({ auth: { kind: 'bearer', secret: 'wrong' } }))
    );
    expect([error.code, error.httpStatus, error.detail]).toEqual([
      'http_error',
      401,
      'Unauthorized',
    ]);
  });

  it('a redirect is refused', async () => {
    const error = await failure(
      mcpListTools(endpoint({ url: running.url.replace('/mcp', '/redirect') }))
    );
    expect([error.code, error.httpStatus]).toEqual(['redirected', 307]);
  });
});
