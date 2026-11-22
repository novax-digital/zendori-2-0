// Minimal MCP client for an org's OWN remote MCP server (Phase 14a): exactly the
// three exchanges Zendori needs — initialize, tools/list, tools/call — over the
// Streamable HTTP transport (JSON or SSE responses).
//
// Written by hand on purpose instead of pulling in the MCP SDK: the worker has
// to control every outbound request (public addresses only, no redirects, a
// hard time and size budget, no automatic retry — CLAUDE.md §3/§12), and the
// client surface is small. Same seams as the custom-api client: injected fetch
// and an injected SSRF guard, so "public addresses only" stays in ONE place.
//
// One call = one short session: initialize → notifications/initialized → the
// request → best-effort DELETE of the session. Nothing is retried: a tools/call
// that may have reached the server is never sent twice.
//
// Not supported: the legacy HTTP+SSE transport (2024-11-05 servers that only
// offer GET /sse), server-initiated requests (sampling, elicitation) and
// resuming a broken response stream.
//
// Security (§7): credentials only travel in request headers. Errors carry a
// code and, for the run log only, a bounded excerpt of what the server said —
// `message` is always the bare code and safe to log.
import { z } from 'zod';
import type { McpToolInfo, McpToolResultData } from '@zendori/core';
import {
  CUSTOM_API_USER_AGENT,
  customApiAuthHeaders,
  type CustomApiAuth,
} from '../custom-api/client.js';

/** The protocol revision this client speaks; the server may answer with an older one. */
export const MCP_CLIENT_PROTOCOL_VERSION = '2025-06-18';
const MCP_CLIENT_INFO = { name: 'zendori', version: '1.0.0' };

export const MCP_LIST_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MCP_CALL_MAX_RESPONSE_BYTES = 256 * 1024;
const HANDSHAKE_MAX_RESPONSE_BYTES = 64 * 1024;
const ERROR_BODY_MAX_BYTES = 4 * 1024;
const MAX_LIST_PAGES = 10;
const DETAIL_MAX_CHARS = 300;
const SESSION_CLOSE_TIMEOUT_MS = 2_000;

export type McpErrorCode =
  | 'blocked_url'
  | 'timeout'
  | 'network'
  | 'response_too_large'
  /** Non-2xx answer (401, 404, 500 …). */
  | 'http_error'
  /** 3xx answer — never followed. */
  | 'redirected'
  /** The answer is not a valid MCP message for our request. */
  | 'protocol_error'
  /** The server answered with a JSON-RPC error. */
  | 'rpc_error';

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly httpStatus: number | null;
  /** JSON-RPC error code (`rpc_error`). */
  readonly rpcCode: number | null;
  /** Bounded text from the server (error message / body excerpt). Never log it. */
  readonly detail: string | null;

  constructor(
    code: McpErrorCode,
    info: { httpStatus?: number | null; rpcCode?: number | null; detail?: string | null } = {}
  ) {
    super(`mcp request failed (${code})`);
    this.name = 'McpError';
    this.code = code;
    this.httpStatus = info.httpStatus ?? null;
    this.rpcCode = info.rpcCode ?? null;
    this.detail = info.detail ?? null;
  }
}

export interface McpEndpoint {
  url: string;
  auth: CustomApiAuth;
  /** Budget for the WHOLE exchange (handshake, request and body download). */
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** SSRF guard — must throw unless the target is publicly routable. Runs before every request. */
  assertUrl?: (url: string) => Promise<unknown>;
  /** Test seam: epoch milliseconds. */
  now?: () => number;
}

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
}

export interface McpToolList {
  server: McpServerInfo;
  tools: McpToolInfo[];
  /** The server has more tools than `maxTools` (or more pages than we read). */
  truncated: boolean;
  /** Entries that were not valid tool definitions (or duplicates). */
  skipped: number;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One line, no control characters, bounded — for a run's error excerpt. */
function clipDetail(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? ' ' : char;
    if (out.length >= DETAIL_MAX_CHARS * 2) break;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX_CHARS);
}

const rpcErrorSchema = z.object({ code: z.number(), message: z.string().nullish() });

const initializeResultSchema = z.object({
  protocolVersion: z.string(),
  serverInfo: z.object({ name: z.string().nullish(), version: z.string().nullish() }).nullish(),
});

const listResultSchema = z.object({
  tools: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
});

const toolSchema = z.object({
  name: z.string().min(1).max(200),
  title: z.string().nullish(),
  description: z.string().nullish(),
  inputSchema: z.record(z.string(), z.unknown()).nullish(),
  annotations: z.unknown().optional(),
});

const callResultSchema = z.object({
  content: z.array(z.unknown()).nullish(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().nullish(),
});

function hint(annotations: unknown, key: string): boolean | null {
  if (!isObject(annotations)) return null;
  const value = annotations[key];
  return typeof value === 'boolean' ? value : null;
}

function normalizeTool(tool: z.infer<typeof toolSchema>): McpToolInfo {
  const annotationTitle =
    isObject(tool.annotations) && typeof tool.annotations.title === 'string'
      ? tool.annotations.title
      : null;
  return {
    name: tool.name,
    title: tool.title ?? annotationTitle,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    readOnlyHint: hint(tool.annotations, 'readOnlyHint'),
    destructiveHint: hint(tool.annotations, 'destructiveHint'),
  };
}

function normalizeResult(result: z.infer<typeof callResultSchema>): McpToolResultData {
  const texts: string[] = [];
  let otherBlocks = 0;
  for (const block of result.content ?? []) {
    if (isObject(block)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
        continue;
      }
      if (
        block.type === 'resource' &&
        isObject(block.resource) &&
        typeof block.resource.text === 'string'
      ) {
        texts.push(block.resource.text);
        continue;
      }
    }
    otherBlocks += 1;
  }
  return {
    texts,
    otherBlocks,
    structuredContent: isObject(result.structuredContent) ? result.structuredContent : null,
    isError: result.isError === true,
  };
}

/**
 * The JSON-RPC response to request `expectId` inside a parsed payload (a single
 * message, or a batch from an older server). Requests and notifications the
 * server sends on the same stream are skipped.
 */
function findResponse(parsed: unknown, expectId: number): JsonObject | null {
  for (const candidate of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!isObject(candidate) || candidate.jsonrpc !== '2.0') continue;
    if (typeof candidate.method === 'string') continue;
    const hasError = 'error' in candidate && candidate.error != null;
    // an error for a request the server could not even read carries id null
    if (candidate.id === null && hasError) return candidate;
    if (String(candidate.id) !== String(expectId)) continue;
    if ('result' in candidate || hasError) return candidate;
  }
  return null;
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Read a body as text with a byte cap. `lenient` (error bodies): return what
 * fits instead of failing on the cap.
 */
async function readText(response: Response, maxBytes: number, lenient: boolean): Promise<string> {
  if (!lenient) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await discard(response);
      throw new McpError('response_too_large', { httpStatus: response.status });
    }
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      if (lenient) {
        chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
        break;
      }
      throw new McpError('response_too_large', { httpStatus: response.status });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Read an SSE response until the JSON-RPC response to `expectId` arrives, then
 * stop reading. Handles CR, LF and CRLF line ends, multi-line data and
 * comments; events without data (keep-alives, priming events) are skipped.
 */
async function readSseResponse(
  response: Response,
  expectId: number,
  maxBytes: number
): Promise<JsonObject | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state: { found: JsonObject | null; tail: string; data: string[] } = {
    found: null,
    tail: '',
    data: [],
  };

  const dispatch = (): void => {
    if (state.data.length === 0) return;
    const data = state.data.join('\n');
    state.data = [];
    if (data.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    state.found = state.found ?? findResponse(parsed, expectId);
  };
  const feedLine = (line: string): void => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    if ((colon === -1 ? line : line.slice(0, colon)) !== 'data') return;
    const value = colon === -1 ? '' : line.slice(colon + 1);
    state.data.push(value.startsWith(' ') ? value.slice(1) : value);
  };
  const feed = (text: string): void => {
    let pending = state.tail + text;
    // a CR at the very end may be the first half of a CRLF — decide next chunk
    let hold = '';
    if (pending.endsWith('\r')) {
      hold = '\r';
      pending = pending.slice(0, -1);
    }
    const lines = pending.replace(/\r\n|\r/g, '\n').split('\n');
    state.tail = (lines.pop() ?? '') + hold;
    for (const line of lines) {
      feedLine(line);
      if (state.found) return;
    }
  };

  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new McpError('response_too_large', { httpStatus: 200 });
      feed(decoder.decode(value, { stream: true }));
      if (state.found) break;
    }
    if (!state.found) {
      // a stream that ends without the closing blank line
      feed(decoder.decode());
      const rest = state.tail.replace(/\r$/, '');
      if (rest !== '') feedLine(rest);
      dispatch();
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return state.found;
}

/** The server's own words about an error, if the body carries any. */
function errorDetail(text: string): string | null {
  if (text.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed) && isObject(parsed.error) && typeof parsed.error.message === 'string') {
      return clipDetail(parsed.error.message);
    }
  } catch {
    // not JSON — use the text itself
  }
  return clipDetail(text);
}

class McpSession {
  private nextId = 1;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly endpoint: McpEndpoint,
    private readonly signal: AbortSignal
  ) {
    this.fetchImpl = endpoint.fetchImpl ?? fetch;
  }

  /** Protocol headers come last: a connection's auth header can never replace them. */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...customApiAuthHeaders(this.endpoint.auth),
      ...extra,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'user-agent': CUSTOM_API_USER_AGENT,
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    };
  }

  private transportError(): McpError {
    return new McpError(this.signal.aborted ? 'timeout' : 'network');
  }

  private async post(body: string, extra: Record<string, string>): Promise<Response> {
    if (this.endpoint.assertUrl) {
      try {
        await this.endpoint.assertUrl(this.endpoint.url);
      } catch {
        throw new McpError('blocked_url');
      }
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint.url, {
        method: 'POST',
        headers: this.headers(extra),
        body,
        redirect: 'manual',
        signal: this.signal,
      });
    } catch {
      throw this.transportError();
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await discard(response);
      throw new McpError('redirected', { httpStatus: response.status || null });
    }
    return response;
  }

  async request(
    method: string,
    params: JsonObject,
    maxBytes: number,
    extraHeaders: Record<string, string> = {}
  ): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const response = await this.post(
      JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      extraHeaders
    );

    // visible ASCII only (spec) — and never more than a header should hold
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId && /^[\x21-\x7e]{1,512}$/.test(sessionId)) this.sessionId = sessionId;

    let message: JsonObject | null;
    try {
      if (!response.ok) {
        const text = await readText(response, ERROR_BODY_MAX_BYTES, true);
        throw new McpError('http_error', {
          httpStatus: response.status,
          detail: errorDetail(text),
        });
      }
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (contentType.includes('text/event-stream')) {
        message = await readSseResponse(response, id, maxBytes);
      } else {
        const text = await readText(response, maxBytes, false);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        message = findResponse(parsed, id);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw this.transportError();
    }

    if (!message) throw new McpError('protocol_error', { httpStatus: response.status });
    if ('error' in message && message.error != null) {
      const parsed = rpcErrorSchema.safeParse(message.error);
      throw new McpError('rpc_error', {
        httpStatus: response.status,
        rpcCode: parsed.success ? parsed.data.code : null,
        detail: parsed.success && parsed.data.message ? clipDetail(parsed.data.message) : null,
      });
    }
    return message.result;
  }

  private async notify(method: string): Promise<void> {
    const response = await this.post(JSON.stringify({ jsonrpc: '2.0', method }), {});
    await discard(response);
    if (!response.ok) throw new McpError('http_error', { httpStatus: response.status });
  }

  async initialize(): Promise<McpServerInfo> {
    const result = await this.request(
      'initialize',
      {
        protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
      HANDSHAKE_MAX_RESPONSE_BYTES
    );
    const parsed = initializeResultSchema.safeParse(result);
    if (!parsed.success || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.data.protocolVersion)) {
      throw new McpError('protocol_error');
    }
    // the server's choice: the same revision or an older one it supports
    this.protocolVersion = parsed.data.protocolVersion;
    await this.notify('notifications/initialized');
    return {
      name: (parsed.data.serverInfo?.name ?? '').slice(0, 200),
      version: (parsed.data.serverInfo?.version ?? '').slice(0, 100),
      protocolVersion: parsed.data.protocolVersion,
    };
  }

  /** Tell a stateful server the session is over. Best effort, own short timeout. */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_CLOSE_TIMEOUT_MS);
    try {
      if (this.endpoint.assertUrl) await this.endpoint.assertUrl(this.endpoint.url);
      const response = await this.fetchImpl(this.endpoint.url, {
        method: 'DELETE',
        headers: this.headers(),
        redirect: 'manual',
        signal: controller.signal,
      });
      await discard(response);
    } catch {
      // the session simply expires on the server
    } finally {
      clearTimeout(timer);
    }
  }
}

async function withSession<T>(
  endpoint: McpEndpoint,
  awaitClose: boolean,
  run: (session: McpSession) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs);
  const session = new McpSession(endpoint, controller.signal);
  try {
    return await run(session);
  } finally {
    clearTimeout(timer);
    const closing = session.close();
    if (awaitClose) await closing;
    else void closing;
  }
}

/**
 * Read a server's tool list (all pages, up to `maxTools`). Doubles as the
 * connection test: it proves address, credentials and protocol in one go.
 */
export async function mcpListTools(
  endpoint: McpEndpoint,
  options: { maxTools?: number } = {}
): Promise<McpToolList> {
  const maxTools = options.maxTools ?? 200;
  return withSession(endpoint, true, async (session) => {
    const server = await session.initialize();
    const tools: McpToolInfo[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    let truncated = false;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await session.request(
        'tools/list',
        cursor ? { cursor } : {},
        MCP_LIST_MAX_RESPONSE_BYTES
      );
      const parsed = listResultSchema.safeParse(result);
      if (!parsed.success) throw new McpError('protocol_error');
      for (const raw of parsed.data.tools) {
        const tool = toolSchema.safeParse(raw);
        if (!tool.success || seen.has(tool.data.name)) {
          skipped += 1;
          continue;
        }
        if (tools.length >= maxTools) {
          truncated = true;
          break;
        }
        seen.add(tool.data.name);
        tools.push(normalizeTool(tool.data));
      }
      cursor = parsed.data.nextCursor ?? null;
      if (truncated || !cursor) break;
      if (page === MAX_LIST_PAGES - 1) truncated = true;
    }
    return { server, tools, truncated, skipped };
  });
}

export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Sent as Idempotency-Key with the tools/call request (the run id). */
  requestId?: string;
}

/**
 * Call ONE tool once. Resolves with the tool's result — including a result the
 * tool itself marks as an error (`isError`); rejects with McpError for
 * transport, HTTP and protocol failures.
 */
export async function mcpCallTool(
  endpoint: McpEndpoint,
  call: McpToolCall
): Promise<{ result: McpToolResultData; latencyMs: number }> {
  const now = endpoint.now ?? Date.now;
  const started = now();
  // the session is closed in the background: the caller (a live conversation)
  // must not wait for a courtesy request
  return withSession(endpoint, false, async (session) => {
    await session.initialize();
    const raw = await session.request(
      'tools/call',
      { name: call.name, arguments: call.arguments },
      MCP_CALL_MAX_RESPONSE_BYTES,
      call.requestId ? { 'idempotency-key': call.requestId } : {}
    );
    const parsed = callResultSchema.safeParse(raw);
    if (!parsed.success) throw new McpError('protocol_error');
    return { result: normalizeResult(parsed.data), latencyMs: now() - started };
  });
}
