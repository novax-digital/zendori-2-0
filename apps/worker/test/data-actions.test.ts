import { describe, expect, it } from 'vitest';
import { createLogger, encryptSecret, verifyStandardWebhook } from '@zendori/core';
import {
  executeQueuedRun,
  failStaleRuns,
  loadAgentActions,
  needsConfirmation,
  runAgentAction,
  type ActionDeps,
  type LoadedAction,
} from '../src/actions/execute.js';
import { createMemoryDb, type MemoryDb } from './memory-supabase.js';

// Phase 13: the worker is the only caller of an org's end system. These tests
// pin the properties that matter for safety: identity comes from the server
// context, a confirmation-required call is never sent, a queued run is claimed
// exactly once, secrets travel only in headers, and every run leaves a row.

const ORG = 'org-1';
const CONN = 'conn-1';
const ACTION = 'action-1';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const SIGNING_SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;

const logger = createLogger('test', 'silent');

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

function recordingFetch(calls: Call[], response: () => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return response();
  }) as typeof fetch;
}

async function seed(
  overrides: { action?: Record<string, unknown>; connection?: Record<string, unknown> } = {}
) {
  const db = createMemoryDb({
    api_connections: [
      {
        id: CONN,
        org_id: ORG,
        base_url: 'https://api.example.com/v1',
        is_active: true,
        config: {
          auth: {
            kind: 'bearer',
            secret_encrypted: await encryptSecret('end-system-token', MASTER_KEY),
          },
          signing_secret_encrypted: await encryptSecret(SIGNING_SECRET, MASTER_KEY),
        },
        ...overrides.connection,
      },
    ],
    data_actions: [
      {
        id: ACTION,
        org_id: ORG,
        connection_id: CONN,
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
            description: '',
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
        ...overrides.action,
      },
    ],
    agent_data_actions: [{ org_id: ORG, agent_id: 'agent-1', data_action_id: ACTION }],
  });
  return db;
}

function deps(db: MemoryDb, fetchImpl: typeof fetch): ActionDeps {
  return {
    supabase: db.client,
    logger,
    masterKey: MASTER_KEY,
    fetchImpl,
    assertUrl: async () => undefined,
  };
}

async function loadAction(db: MemoryDb): Promise<LoadedAction> {
  const actions = await loadAgentActions(db.client, ORG, 'agent-1');
  expect(actions).toHaveLength(1);
  return actions[0] as LoadedAction;
}

describe('loadAgentActions', () => {
  it('returns linked, active actions of active connections', async () => {
    const db = await seed();
    const action = await loadAction(db);
    expect(action.name).toBe('bestellstatus');
    expect(action.responseFields).toEqual(['status']);
  });

  it('hides actions that are paused or whose connection is paused', async () => {
    expect(
      await loadAgentActions((await seed({ action: { is_active: false } })).client, ORG, 'agent-1')
    ).toEqual([]);
    expect(
      await loadAgentActions(
        (await seed({ connection: { is_active: false } })).client,
        ORG,
        'agent-1'
      )
    ).toEqual([]);
  });

  it('returns nothing for an agent without links', async () => {
    const db = await seed();
    expect(await loadAgentActions(db.client, ORG, 'agent-2')).toEqual([]);
  });
});

describe('needsConfirmation', () => {
  it('never holds back a read action', () => {
    expect(needsConfirmation({ kind: 'read', requiresConfirmation: true }, 'draft_only')).toBe(
      false
    );
  });
  it('holds a write action back when it says so or when the agent only drafts', () => {
    expect(needsConfirmation({ kind: 'write', requiresConfirmation: true }, 'autopilot')).toBe(
      true
    );
    expect(needsConfirmation({ kind: 'write', requiresConfirmation: false }, 'draft_only')).toBe(
      true
    );
    expect(needsConfirmation({ kind: 'write', requiresConfirmation: false }, 'autopilot')).toBe(
      false
    );
  });
});

describe('runAgentAction', () => {
  it('calls the end system with the server-side identity, auth and signature, and logs the run', async () => {
    const db = await seed();
    const calls: Call[] = [];
    const fetchImpl = recordingFetch(
      calls,
      () => new Response(JSON.stringify({ status: 'shipped', margin: 0.4 }), { status: 200 })
    );
    const result = await runAgentAction(deps(db, fetchImpl), {
      action: await loadAction(db),
      // the model tries to smuggle another customer's address — ignored
      modelArgs: { order_id: '4711', email: 'opfer@example.com' },
      context: { 'contact.email': 'kunde@example.com' },
      conversationId: 'conv-1',
      messageId: 'msg-1',
      agentId: 'agent-1',
      confirm: false,
    });

    expect(result).toEqual({ ok: true, status: 'done', data: { status: 'shipped' } });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe('https://api.example.com/v1/orders/4711?email=kunde%40example.com');
    expect(call.headers.get('authorization')).toBe('Bearer end-system-token');

    const run = db.rows('action_runs')[0] as Record<string, unknown>;
    expect(run.state).toBe('succeeded');
    expect(run.trigger).toBe('agent');
    expect(run.args).toEqual({ order_id: '4711', email: 'kunde@example.com' });
    expect(run.result).toEqual({ status: 'shipped' });
    expect(run.http_status).toBe(200);
    expect(run.conversation_id).toBe('conv-1');
    // the run id is the idempotency key AND the signed delivery id
    expect(call.headers.get('idempotency-key')).toBe(run.id);
    expect(() =>
      verifyStandardWebhook(
        '',
        {
          id: call.headers.get('webhook-id'),
          timestamp: call.headers.get('webhook-timestamp'),
          signature: call.headers.get('webhook-signature'),
        },
        SIGNING_SECRET
      )
    ).not.toThrow();
  });

  it('records a confirmation-required call without sending anything', async () => {
    const db = await seed({
      action: { kind: 'write', method: 'POST', requires_confirmation: true },
    });
    const calls: Call[] = [];
    const result = await runAgentAction(
      deps(
        db,
        recordingFetch(calls, () => new Response('{}'))
      ),
      {
        action: await loadAction(db),
        modelArgs: { order_id: '4711' },
        context: { 'contact.email': 'kunde@example.com' },
        conversationId: 'conv-1',
        messageId: 'msg-1',
        agentId: 'agent-1',
        confirm: true,
      }
    );
    expect(result).toMatchObject({ ok: true, status: 'pending_approval' });
    expect(calls).toHaveLength(0);
    expect(db.rows('action_runs')[0]).toMatchObject({
      state: 'pending_approval',
      args: { order_id: '4711', email: 'kunde@example.com' },
    });
  });

  it('fails without a call when the conversation lacks a required context value', async () => {
    const db = await seed();
    const calls: Call[] = [];
    const result = await runAgentAction(
      deps(
        db,
        recordingFetch(calls, () => new Response('{}'))
      ),
      {
        action: await loadAction(db),
        modelArgs: { order_id: '4711' },
        context: { 'contact.email': null },
        conversationId: 'conv-1',
        messageId: null,
        agentId: 'agent-1',
        confirm: false,
      }
    );
    expect(result).toEqual({ ok: false, error: 'missing_context', parameter: 'email' });
    expect(calls).toHaveLength(0);
    expect(db.rows('action_runs')[0]).toMatchObject({
      state: 'failed',
      error_code: 'missing_context',
    });
  });

  it('reports an error status of the end system as a failed run with a bounded excerpt', async () => {
    const db = await seed();
    const result = await runAgentAction(
      deps(
        db,
        recordingFetch(
          [],
          () => new Response(JSON.stringify({ message: 'order not found' }), { status: 404 })
        )
      ),
      {
        action: await loadAction(db),
        modelArgs: { order_id: '1' },
        context: { 'contact.email': 'kunde@example.com' },
        conversationId: 'conv-1',
        messageId: null,
        agentId: 'agent-1',
        confirm: false,
      }
    );
    expect(result).toEqual({
      ok: false,
      error: 'http_error',
      http_status: 404,
      detail: { message: 'order not found' },
    });
    expect(db.rows('action_runs')[0]).toMatchObject({ state: 'failed', error_code: 'http_error' });
  });

  it('refuses when the SSRF guard rejects the target', async () => {
    const db = await seed();
    const calls: Call[] = [];
    const result = await runAgentAction(
      {
        ...deps(
          db,
          recordingFetch(calls, () => new Response('{}'))
        ),
        assertUrl: async () => {
          throw new Error('private');
        },
      },
      {
        action: await loadAction(db),
        modelArgs: { order_id: '1' },
        context: { 'contact.email': 'kunde@example.com' },
        conversationId: 'conv-1',
        messageId: null,
        agentId: 'agent-1',
        confirm: false,
      }
    );
    expect(result).toEqual({ ok: false, error: 'blocked_url' });
    expect(calls).toHaveLength(0);
  });

  it('cannot run a connection with credentials when the master key is missing', async () => {
    const db = await seed();
    const result = await runAgentAction(
      {
        ...deps(
          db,
          recordingFetch([], () => new Response('{}'))
        ),
        masterKey: undefined,
      },
      {
        action: await loadAction(db),
        modelArgs: { order_id: '1' },
        context: { 'contact.email': 'kunde@example.com' },
        conversationId: 'conv-1',
        messageId: null,
        agentId: 'agent-1',
        confirm: false,
      }
    );
    expect(result).toEqual({ ok: false, error: 'config_invalid' });
  });

  it('stops at the per-minute cap of the org', async () => {
    const db = await seed();
    const now = new Date().toISOString();
    for (let i = 0; i < 60; i += 1) {
      db.rows('action_runs').push({
        id: `old-${i}`,
        org_id: ORG,
        created_at: now,
        state: 'succeeded',
      });
    }
    const calls: Call[] = [];
    const result = await runAgentAction(
      deps(
        db,
        recordingFetch(calls, () => new Response('{}'))
      ),
      {
        action: await loadAction(db),
        modelArgs: { order_id: '1' },
        context: { 'contact.email': 'kunde@example.com' },
        conversationId: 'conv-1',
        messageId: null,
        agentId: 'agent-1',
        confirm: false,
      }
    );
    expect(result).toEqual({ ok: false, error: 'rate_limited' });
    expect(calls).toHaveLength(0);
  });
});

describe('executeQueuedRun', () => {
  function queuedRun(db: MemoryDb, patch: Record<string, unknown> = {}): string {
    const id = 'run-queued';
    db.rows('action_runs').push({
      id,
      org_id: ORG,
      data_action_id: ACTION,
      trigger: 'test',
      state: 'queued',
      args: { order_id: '4711', email: 'test@example.com' },
      created_at: new Date().toISOString(),
      ...patch,
    });
    return id;
  }

  it('executes a queued run with its stored values', async () => {
    const db = await seed();
    const runId = queuedRun(db);
    const calls: Call[] = [];
    await executeQueuedRun(
      deps(
        db,
        recordingFetch(
          calls,
          () => new Response(JSON.stringify({ status: 'open' }), { status: 200 })
        )
      ),
      runId
    );
    expect(calls).toHaveLength(1);
    expect((calls[0] as Call).url).toBe(
      'https://api.example.com/v1/orders/4711?email=test%40example.com'
    );
    expect(db.rows('action_runs')[0]).toMatchObject({
      state: 'succeeded',
      result: { status: 'open' },
    });
  });

  it('a second delivery of the same job does not call the end system again', async () => {
    const db = await seed();
    const runId = queuedRun(db);
    const calls: Call[] = [];
    const d = deps(
      db,
      recordingFetch(calls, () => new Response('{"status":"open"}', { status: 200 }))
    );
    await executeQueuedRun(d, runId);
    await executeQueuedRun(d, runId);
    expect(calls).toHaveLength(1);
  });

  it('leaves a run alone that is not queued (waiting for confirmation, rejected)', async () => {
    const db = await seed();
    const runId = queuedRun(db, { state: 'pending_approval' });
    const calls: Call[] = [];
    await executeQueuedRun(
      deps(
        db,
        recordingFetch(calls, () => new Response('{}'))
      ),
      runId
    );
    expect(calls).toHaveLength(0);
    expect(db.rows('action_runs')[0]).toMatchObject({ state: 'pending_approval' });
  });

  it('an approved run of a paused action fails; a test run still executes', async () => {
    const paused = await seed({ action: { is_active: false } });
    const approvedId = queuedRun(paused, { trigger: 'agent' });
    const calls: Call[] = [];
    await executeQueuedRun(
      deps(
        paused,
        recordingFetch(calls, () => new Response('{}'))
      ),
      approvedId
    );
    expect(calls).toHaveLength(0);
    expect(paused.rows('action_runs')[0]).toMatchObject({
      state: 'failed',
      error_code: 'action_inactive',
    });

    const pausedTest = await seed({ action: { is_active: false } });
    const testId = queuedRun(pausedTest, { trigger: 'test' });
    await executeQueuedRun(
      deps(
        pausedTest,
        recordingFetch(calls, () => new Response('{"status":"x"}', { status: 200 }))
      ),
      testId
    );
    expect(calls).toHaveLength(1);
  });

  it('fails a queued run whose stored values no longer fit the definition', async () => {
    const db = await seed();
    const runId = queuedRun(db, { args: { email: 'test@example.com' } });
    await executeQueuedRun(
      deps(
        db,
        recordingFetch([], () => new Response('{}'))
      ),
      runId
    );
    expect(db.rows('action_runs')[0]).toMatchObject({
      state: 'failed',
      error_code: 'invalid_args',
    });
  });
});

describe('failStaleRuns', () => {
  it('closes runs stuck in running, keyed on the start time', async () => {
    const db = createMemoryDb({
      action_runs: [
        {
          id: 'stale',
          state: 'running',
          started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        },
        { id: 'fresh', state: 'running', started_at: new Date().toISOString() },
        // approved late: created long ago but only just started
        {
          id: 'old-but-fresh',
          state: 'running',
          created_at: new Date(Date.now() - 86_400_000).toISOString(),
          started_at: new Date().toISOString(),
        },
      ],
    });
    await failStaleRuns(db.client);
    const state = (id: string) => db.rows('action_runs').find((r) => r.id === id)?.state;
    expect(state('stale')).toBe('failed');
    expect(state('fresh')).toBe('running');
    expect(state('old-but-fresh')).toBe('running');
  });
});
