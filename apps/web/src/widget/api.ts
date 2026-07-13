import type {
  BootstrapResponse,
  ContactDetails,
  HistoryMessage,
  SessionResponse,
  StoredSession,
  WidgetConfig,
} from './types';

/**
 * HTTP layer for the /api/widget/* routes. Responses are shape-checked by
 * hand (no zod in the browser bundle to keep it small); the server validates
 * all inputs with zod. Network-level failures bubble up as TypeError from
 * fetch, HTTP errors as WidgetApiError.
 */

export class WidgetApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Widget API request failed with status ${status}`);
    this.name = 'WidgetApiError';
    this.status = status;
  }
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new WidgetApiError(response.status);
  return (await response.json()) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function invalidResponse(): Error {
  return new Error('Widget API returned an unexpected response shape');
}

function parseHistoryMessage(value: unknown): HistoryMessage | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || typeof value.content !== 'string') return null;
  return {
    id: value.id,
    content: value.content,
    content_type: asString(value.content_type) || 'text',
    sender_type: asString(value.sender_type),
    created_at: asString(value.created_at),
  };
}

export async function fetchBootstrap(config: WidgetConfig): Promise<BootstrapResponse> {
  const data = await postJson(`${config.apiBase}/api/widget/bootstrap`, { token: config.token });
  if (!isRecord(data) || !isRecord(data.theme) || !isRecord(data.realtime)) throw invalidResponse();
  const url = asString(data.realtime.url);
  const anonKey = asString(data.realtime.anonKey);
  if (!url || !anonKey) throw invalidResponse();
  return {
    theme: {
      color: asString(data.theme.color),
      title: asString(data.theme.title),
      greeting: asString(data.theme.greeting),
    },
    realtime: { url, anonKey },
  };
}

export async function createOrResumeSession(
  config: WidgetConfig,
  resume: StoredSession | null
): Promise<SessionResponse | 'expired'> {
  const body: Record<string, unknown> = { token: config.token };
  if (resume) body.resume = resume;
  const data = await postJson(`${config.apiBase}/api/widget/session`, body);
  // invalid resume → the server tells us to start over as a first-time visitor
  if (isRecord(data) && data.expired === true) return 'expired';
  if (
    !isRecord(data) ||
    typeof data.conversationId !== 'string' ||
    typeof data.topic !== 'string'
  ) {
    throw invalidResponse();
  }
  const rawMessages = Array.isArray(data.messages) ? (data.messages as unknown[]) : [];
  const messages: HistoryMessage[] = [];
  for (const entry of rawMessages) {
    const parsed = parseHistoryMessage(entry);
    if (parsed) messages.push(parsed);
  }
  return {
    conversationId: data.conversationId,
    secret: asString(data.secret),
    topic: data.topic,
    messages,
  };
}

export async function sendWidgetMessage(
  config: WidgetConfig,
  session: StoredSession,
  payload: { clientMessageId: string; content?: string; contact?: ContactDetails }
): Promise<void> {
  const body: Record<string, unknown> = {
    token: config.token,
    conversationId: session.conversationId,
    secret: session.secret,
    clientMessageId: payload.clientMessageId,
  };
  if (payload.content !== undefined) body.content = payload.content;
  if (payload.contact !== undefined) body.contact = payload.contact;
  const data = await postJson(`${config.apiBase}/api/widget/message`, body);
  if (!isRecord(data) || data.ok !== true) throw invalidResponse();
}
