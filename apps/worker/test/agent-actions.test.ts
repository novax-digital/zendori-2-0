import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@zendori/core';
import type { VoiceChannelConfig } from '@zendori/channels';
import { createMemoryDb, type MemoryDb } from './memory-supabase.js';

// Phase 13b: how the two agent kinds use data actions. Text: the draft session
// (tools + executor + counters) built from the conversation. Voice: the tool
// definitions in the session config and the function-tool handler.

// Voice confirmation creates a callback ticket through the ticket service —
// pinned here by call, exercised in packages/core.
const ensureTicketMock = vi.fn(async () => ({ id: 'ticket-1', outcome: 'created' }));
vi.mock('../src/pipeline/tickets.js', () => ({
  ensureTicketForConversation: ensureTicketMock,
}));

const { prepareDraftActions, toDraftTool } = await import('../src/pipeline/draft-actions.js');
const { loadAgentActions } = await import('../src/actions/execute.js');
const {
  ACTION_FAILED_INSTRUCTION,
  ACTION_MISSING_CONTEXT_INSTRUCTION,
  ACTION_PENDING_INSTRUCTION,
  VOICE_ACTION_MAX_CALLS,
  dataActionTool,
  findVoiceAction,
} = await import('../src/voice/action-tool.js');
const { buildActionTool, buildSessionConfig } = await import('../src/voice/session-config.js');

const ORG = 'org-1';
const logger = createLogger('test', 'silent');

interface Call {
  url: string;
  method: string;
  body: string | null;
}

function recordingFetch(calls: Call[], response: () => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return response();
  }) as typeof fetch;
}

const READ_ACTION = {
  id: 'action-read',
  org_id: ORG,
  connection_id: 'conn-1',
  name: 'bestellstatus',
  label: 'Bestellstatus abfragen',
  description: 'Liefert den Status einer Bestellung.',
  kind: 'read',
  method: 'GET',
  path: '/orders/{order_id}',
  parameters: [
    {
      key: 'order_id',
      in: 'path',
      source: 'agent',
      type: 'string',
      description: 'Bestellnummer',
      required: true,
    },
    {
      key: 'email',
      in: 'query',
      source: 'context',
      type: 'string',
      description: '',
      required: true,
      contextKey: 'contact.email',
    },
  ],
  response_fields: ['status'],
  requires_confirmation: false,
  timeout_ms: 5000,
  is_active: true,
  created_at: '2026-11-20T10:00:00.000Z',
};

const WRITE_ACTION = {
  ...READ_ACTION,
  id: 'action-write',
  name: 'termin_buchen',
  label: 'Termin buchen',
  description: 'Bucht einen Termin.',
  kind: 'write',
  method: 'POST',
  path: '/appointments',
  parameters: [
    { key: 'day', in: 'body', source: 'agent', type: 'string', description: 'Tag', required: true },
    {
      key: 'phone',
      in: 'body',
      source: 'context',
      type: 'string',
      description: '',
      required: false,
      contextKey: 'contact.phone',
    },
  ],
  response_fields: [],
  created_at: '2026-11-20T10:01:00.000Z',
};

function seed(writePatch: Record<string, unknown> = {}): MemoryDb {
  return createMemoryDb({
    api_connections: [
      {
        id: 'conn-1',
        org_id: ORG,
        base_url: 'https://api.example.com',
        is_active: true,
        config: { auth: { kind: 'none' } },
      },
    ],
    data_actions: [READ_ACTION, { ...WRITE_ACTION, ...writePatch }],
    agent_data_actions: [
      { org_id: ORG, agent_id: 'agent-1', data_action_id: 'action-read' },
      { org_id: ORG, agent_id: 'agent-1', data_action_id: 'action-write' },
    ],
    conversations: [{ id: 'conv-1', org_id: ORG, contact_id: 'contact-1', status: 'open' }],
    contacts: [
      {
        id: 'contact-1',
        org_id: ORG,
        name: 'Kai Beispiel',
        email: 'kai@example.com',
        phone: '+4915112345678',
      },
    ],
  });
}

function prepare(
  db: MemoryDb,
  mode: 'autopilot' | 'draft_only' | 'intake_only',
  fetchImpl: typeof fetch
) {
  return prepareDraftActions(db.client, {
    orgId: ORG,
    agent: { id: 'agent-1', mode },
    conversationId: 'conv-1',
    messageId: 'msg-1',
    channelType: 'chat',
    masterKey: undefined,
    fetchImpl,
    assertUrl: async () => undefined,
  });
}

describe('prepareDraftActions (text pipeline)', () => {
  it('returns null for an agent without actions and for the intake mode', async () => {
    const db = seed();
    db.tables.agent_data_actions = [];
    expect(await prepare(db, 'autopilot', fetch)).toBeNull();
    expect(await prepare(seed(), 'intake_only', fetch)).toBeNull();
  });

  it('offers one tool per action, exposing only agent parameters', async () => {
    const session = await prepare(seed(), 'autopilot', fetch);
    expect(session?.tools.map((t) => t.name)).toEqual(['bestellstatus', 'termin_buchen']);
    expect(session?.tools[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { order_id: { type: 'string', description: 'Bestellnummer' } },
      required: ['order_id'],
    });
    expect(session?.tools[1]?.description).toContain('Schreibende Aktion');
  });

  it('binds the customer identity from the conversation, not from the model', async () => {
    const db = seed();
    const calls: Call[] = [];
    const session = await prepare(
      db,
      'autopilot',
      recordingFetch(calls, () => new Response('{"status":"shipped","margin":1}', { status: 200 }))
    );
    const result = await session?.runTool({
      name: 'bestellstatus',
      input: { order_id: '4711', email: 'opfer@example.com' },
    });
    expect(result).toEqual({ ok: true, data: { status: 'shipped' } });
    expect(calls[0]?.url).toBe('https://api.example.com/orders/4711?email=kai%40example.com');
    expect(session?.stats).toEqual({ calls: 1, pendingApproval: 0, succeeded: 1, failed: 0 });
    expect(db.rows('action_runs')[0]).toMatchObject({ message_id: 'msg-1', agent_id: 'agent-1' });
  });

  it('an autopilot agent executes a write action that needs no confirmation', async () => {
    const db = seed();
    const calls: Call[] = [];
    const session = await prepare(
      db,
      'autopilot',
      recordingFetch(calls, () => new Response('{"id":"t1"}', { status: 201 }))
    );
    const result = await session?.runTool({ name: 'termin_buchen', input: { day: '2026-12-01' } });
    expect(result).toEqual({ ok: true, data: { id: 't1' } });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      day: '2026-12-01',
      phone: '+4915112345678',
    });
  });

  it('a draft-only agent never executes a write action itself', async () => {
    const db = seed();
    const calls: Call[] = [];
    const session = await prepare(
      db,
      'draft_only',
      recordingFetch(calls, () => new Response('{}'))
    );
    const result = await session?.runTool({ name: 'termin_buchen', input: { day: '2026-12-01' } });
    expect(result).toEqual({ ok: true, status: 'pending_approval' });
    expect(calls).toHaveLength(0);
    expect(session?.stats.pendingApproval).toBe(1);
    expect(db.rows('action_runs')[0]).toMatchObject({ state: 'pending_approval' });
  });

  it('a write action marked for confirmation waits even on autopilot', async () => {
    const db = seed({ requires_confirmation: true });
    const calls: Call[] = [];
    const session = await prepare(
      db,
      'autopilot',
      recordingFetch(calls, () => new Response('{}'))
    );
    await session?.runTool({ name: 'termin_buchen', input: { day: '2026-12-01' } });
    expect(calls).toHaveLength(0);
    expect(session?.stats.pendingApproval).toBe(1);
  });

  it('the same call for the same message is sent once (pipeline retry / repeated call)', async () => {
    const db = seed();
    const calls: Call[] = [];
    const fetchImpl = recordingFetch(calls, () => new Response('{"id":"t1"}', { status: 201 }));
    const first = await prepare(db, 'autopilot', fetchImpl);
    await first?.runTool({ name: 'termin_buchen', input: { day: '2026-12-01' } });
    // a retried pipeline run builds a fresh session for the SAME message
    const retry = await prepare(db, 'autopilot', fetchImpl);
    const again = await retry?.runTool({ name: 'termin_buchen', input: { day: '2026-12-01' } });
    expect(again).toEqual({ ok: true, data: { id: 't1' } });
    expect(calls).toHaveLength(1);
    expect(db.rows('action_runs')).toHaveLength(1);
    // different values are a different request
    await retry?.runTool({ name: 'termin_buchen', input: { day: '2026-12-02' } });
    expect(calls).toHaveLength(2);
  });

  it('an interrupted earlier run is neither re-sent nor reported as done', async () => {
    const db = seed();
    // a previous pipeline attempt died mid-call: the run is still 'running'
    db.rows('action_runs').push({
      id: 'run-interrupted',
      org_id: ORG,
      data_action_id: 'action-write',
      message_id: 'msg-1',
      state: 'running',
      args: { day: '2026-12-01', phone: '+4915112345678' },
      created_at: new Date().toISOString(),
    });
    const calls: Call[] = [];
    const session = await prepare(
      db,
      'autopilot',
      recordingFetch(calls, () => new Response('{}'))
    );
    const result = await session?.runTool({ name: 'termin_buchen', input: { day: '2026-12-01' } });
    expect(result).toEqual({ ok: false, error: 'timeout' });
    expect(calls).toHaveLength(0);
    expect(session?.stats).toMatchObject({ failed: 1, pendingApproval: 0, succeeded: 0 });
  });

  it('counts failures and refuses unknown tool names', async () => {
    const db = seed();
    const session = await prepare(
      db,
      'autopilot',
      recordingFetch([], () => new Response('nope', { status: 500 }))
    );
    expect(
      await session?.runTool({ name: 'bestellstatus', input: { order_id: '1' } })
    ).toMatchObject({
      ok: false,
      error: 'http_error',
      http_status: 500,
    });
    expect(await session?.runTool({ name: 'drop_database', input: {} })).toEqual({
      ok: false,
      error: 'unknown_tool',
    });
    expect(session?.stats).toMatchObject({ calls: 2, failed: 2, succeeded: 0 });
  });
});

describe('voice: tool definitions', () => {
  const CONFIG = {
    type: 'voice',
    voice: 'ara',
    languageHint: 'de',
    keyterms: [],
    speechSpeed: 1.0,
  } as unknown as VoiceChannelConfig;
  const AGENT = {
    identity: null,
    knowledgeBaseIds: null,
    handoffEnabled: true,
    escalationTarget: 'human' as const,
    confidenceThreshold: 0.7,
    intakeFields: ['name' as const, 'phone' as const],
  };

  it('builds a function tool with the agent parameters only', async () => {
    const [action] = await loadAgentActions(seed().client, ORG, 'agent-1');
    expect(buildActionTool(action!)).toEqual({
      type: 'function',
      name: 'bestellstatus',
      description: 'Liefert den Status einer Bestellung.',
      parameters: {
        type: 'object',
        properties: { order_id: { type: 'string', description: 'Bestellnummer' } },
        required: ['order_id'],
      },
    });
    expect(toDraftTool(action!).name).toBe('bestellstatus');
  });

  it('an answering agent gets its actions and the rules; an intake agent gets neither', async () => {
    const actions = await loadAgentActions(seed().client, ORG, 'agent-1');
    const answer = buildSessionConfig(
      CONFIG,
      { ...AGENT, mode: 'answer', actions },
      { companyName: 'Acme' }
    );
    expect(answer.tools?.map((t) => t.name)).toEqual([
      'kb_search',
      'bestellstatus',
      'termin_buchen',
      'create_ticket',
      'handoff_human',
      'end_call',
    ]);
    expect(answer.instructions).toContain('Aktionen im System des Unternehmens');

    const intake = buildSessionConfig(
      CONFIG,
      { ...AGENT, mode: 'intake_only', actions },
      { companyName: 'Acme' }
    );
    expect(intake.tools?.map((t) => t.name)).toEqual([
      'create_ticket',
      'handoff_human',
      'end_call',
    ]);
    expect(intake.instructions).not.toContain('Aktionen im System des Unternehmens');
  });

  it('without actions the prompt and tool list are unchanged', () => {
    const plain = buildSessionConfig(CONFIG, { ...AGENT, mode: 'answer' }, { companyName: 'Acme' });
    expect(plain.tools?.map((t) => t.name)).toEqual([
      'kb_search',
      'create_ticket',
      'handoff_human',
      'end_call',
    ]);
    expect(plain.instructions).not.toContain('Aktionen im System des Unternehmens');
  });
});

describe('voice: dataActionTool', () => {
  async function setup(
    db: MemoryDb,
    fetchImpl: typeof fetch,
    email: string | null = 'kai@example.com'
  ) {
    const actions = await loadAgentActions(db.client, ORG, 'agent-1');
    return {
      ctx: {
        supabase: db.client,
        logger,
        orgId: ORG,
        conversationId: 'conv-1',
        callStartedAt: '2026-11-20T10:00:00.000Z',
        ticketState: { ticketId: null as string | null },
      },
      setupArg: {
        actions,
        agentId: 'agent-1',
        masterKey: undefined,
        fetchImpl,
        assertUrl: async () => undefined,
        context: {
          'contact.email': email,
          'contact.phone': '+4915112345678',
          'conversation.id': 'conv-1',
          'channel.type': 'voice',
        },
      },
    };
  }

  it('returns the mapped data of a read action', async () => {
    const db = seed();
    const { ctx, setupArg } = await setup(
      db,
      recordingFetch([], () => new Response('{"status":"shipped"}', { status: 200 }))
    );
    const action = findVoiceAction(setupArg, 'bestellstatus')!;
    const result = await dataActionTool(ctx, setupArg, action, { order_id: '4711' }, 0);
    expect(result).toMatchObject({ ok: true, data: { status: 'shipped' } });
    expect(db.rows('action_runs')[0]).toMatchObject({ state: 'succeeded', message_id: null });
  });

  it('a confirmation-required action becomes a callback ticket in the pending queue', async () => {
    ensureTicketMock.mockClear();
    const db = seed({ requires_confirmation: true });
    const calls: Call[] = [];
    const { ctx, setupArg } = await setup(
      db,
      recordingFetch(calls, () => new Response('{}'))
    );
    const action = findVoiceAction(setupArg, 'termin_buchen')!;
    const result = await dataActionTool(ctx, setupArg, action, { day: '2026-12-01' }, 0);

    expect(result).toEqual({
      ok: true,
      status: 'pending_approval',
      instruction: ACTION_PENDING_INSTRUCTION,
    });
    expect(calls).toHaveLength(0);
    expect(ensureTicketMock).toHaveBeenCalledTimes(1);
    expect(ensureTicketMock.mock.calls[0]?.[1]).toMatchObject({
      origin: 'voice',
      attach: 'always',
      subject: 'Bestätigung offen: Termin buchen',
    });
    expect(ctx.ticketState.ticketId).toBe('ticket-1');
    expect(db.rows('conversations')[0]).toMatchObject({ status: 'pending' });
  });

  it('tells the model what to do when the caller identity lacks a required value', async () => {
    const db = seed();
    const { ctx, setupArg } = await setup(
      db,
      recordingFetch([], () => new Response('{}')),
      null
    );
    const action = findVoiceAction(setupArg, 'bestellstatus')!;
    const result = await dataActionTool(ctx, setupArg, action, { order_id: '4711' }, 0);
    expect(result).toMatchObject({
      ok: false,
      error: 'missing_context',
      instruction: ACTION_MISSING_CONTEXT_INSTRUCTION,
    });
  });

  it('a failed call carries the honest-failure instruction', async () => {
    const db = seed();
    const { ctx, setupArg } = await setup(
      db,
      recordingFetch([], () => new Response('down', { status: 503 }))
    );
    const action = findVoiceAction(setupArg, 'bestellstatus')!;
    const result = await dataActionTool(ctx, setupArg, action, { order_id: '4711' }, 0);
    expect(result).toMatchObject({
      ok: false,
      error: 'http_error',
      instruction: ACTION_FAILED_INSTRUCTION,
    });
  });

  it('stops after the per-call limit without touching the end system', async () => {
    const db = seed();
    const calls: Call[] = [];
    const { ctx, setupArg } = await setup(
      db,
      recordingFetch(calls, () => new Response('{}'))
    );
    const action = findVoiceAction(setupArg, 'bestellstatus')!;
    const result = await dataActionTool(
      ctx,
      setupArg,
      action,
      { order_id: '1' },
      VOICE_ACTION_MAX_CALLS
    );
    expect(result).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(calls).toHaveLength(0);
  });

  it('findVoiceAction only resolves names of this session', async () => {
    const { setupArg } = await setup(seed(), fetch);
    expect(findVoiceAction(setupArg, 'kb_search')).toBeNull();
    expect(findVoiceAction(undefined, 'bestellstatus')).toBeNull();
  });
});
