import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger, SupabaseClient } from '@zendori/core';
import type { VoiceChannelConfig } from '@zendori/channels';

// Voice dispatch: the ingress-free worker learns of incoming calls via a
// Supabase Realtime broadcast and joins the xAI WebSocket. These tests drive
// claimAndJoin deterministically through the captured broadcast handler (not the
// 3s timer sweep) with CallSession mocked out, and assert the atomic claim, the
// concurrency cap, agent-mode resolution (0011), the terminal-fail paths, the
// release-back-to-ringing on transient errors, and boot-time orphan cleanup.

const { envHolder, dbHolder, sessionRegistry } = vi.hoisted(() => ({
  envHolder: {
    XAI_API_KEY: 'test-key' as string | undefined,
    VOICE_MAX_CONCURRENT_CALLS: 10 as number | undefined,
  },
  dbHolder: { client: undefined as unknown },
  sessionRegistry: { constructed: [] as Array<Record<string, unknown>> },
}));

vi.mock('@zendori/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, loadWorkerEnv: () => ({ ...envHolder }) };
});
vi.mock('../src/db.js', () => ({
  getServiceClient: () => dbHolder.client,
  toErrorInfo: (e: unknown) => ({ name: 'e', message: String(e) }),
}));
vi.mock('../src/voice/call-session.js', () => ({
  CallSession: class {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      sessionRegistry.constructed.push(opts);
    }
    start(): void {}
    async drain(): Promise<void> {}
  },
}));

const { startVoiceDispatch } = await import('../src/voice/dispatch.js');

// --- fakes -----------------------------------------------------------------------

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

interface Req {
  table: string;
  op: 'select' | 'insert' | 'update';
  patch?: Record<string, unknown>;
  filters: Record<string, unknown>;
  selectArg?: string;
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

// The broadcast payload schema validates z.uuid(), so these must be real UUIDs.
const IDS = {
  voiceCall: '00000000-0000-4000-8000-000000000001',
  voiceCall2: '00000000-0000-4000-8000-000000000002',
  org: '00000000-0000-4000-8000-0000000000aa',
  channel: '00000000-0000-4000-8000-0000000000bb',
  conversation: '00000000-0000-4000-8000-0000000000cc',
};

const CALL_ROW = {
  id: IDS.voiceCall,
  provider_call_id: 'call-abc',
  org_id: IDS.org,
  channel_id: IDS.channel,
  conversation_id: IDS.conversation,
  created_at: '2026-07-15T10:00:00.000Z',
};

/** Scenario-driven fake: `respond(req)` returns the { data, error } per query. */
function makeFake(respond: (req: Req) => { data: unknown; error: unknown }) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const updates: { table: string; patch: Record<string, unknown> }[] = [];
  let broadcastHandler: ((msg: { payload?: unknown }) => void) | null = null;

  function builder(table: string, op: Req['op'], seed: Partial<Req>) {
    const req: Req = { table, op, filters: {}, ...seed };
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(respond(req));
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return async () => respond(req);
          }
          if (prop === 'select') {
            return (arg?: string) => {
              req.selectArg = arg;
              return proxy;
            };
          }
          if (prop === 'eq' || prop === 'in' || prop === 'is') {
            return (col: string, val: unknown) => {
              req.filters[col] = val;
              return proxy;
            };
          }
          return () => proxy; // order / limit
        },
      }
    );
    return proxy;
  }

  const client = {
    from(table: string) {
      return {
        select(arg?: string) {
          return builder(table, 'select', { selectArg: arg });
        },
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return builder(table, 'insert', {});
        },
        update(patch: Record<string, unknown>) {
          updates.push({ table, patch });
          return builder(table, 'update', { patch });
        },
      };
    },
    channel() {
      const chProxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'on') {
              return (_type: string, _filter: unknown, cb: (msg: { payload?: unknown }) => void) => {
                broadcastHandler = cb;
                return chProxy;
              };
            }
            return () => chProxy; // subscribe
          },
        }
      );
      return chProxy;
    },
    removeChannel: async () => undefined,
  } as unknown as SupabaseClient;

  return {
    client,
    inserts,
    updates,
    ready: () => broadcastHandler !== null,
    fireBroadcast: (payload: unknown) => broadcastHandler?.({ payload }),
  };
}

interface Scenario {
  claim?: 'row' | 'empty';
  channel?: 'ok' | 'error' | 'null' | 'invalidConfig';
  agent?: { identity: string | null; mode: string; is_active: boolean } | null;
  kbLinks?: string[];
}

function respondFor(spec: Scenario) {
  return (req: Req): { data: unknown; error: unknown } => {
    const { table, op, patch } = req;
    if (table === 'voice_calls') {
      if (op === 'update' && patch?.status === 'connecting') {
        return { data: spec.claim === 'empty' ? [] : [CALL_ROW], error: null };
      }
      return { data: null, error: null }; // release / fail / orphan cleanup
    }
    if (table === 'channels') {
      if (spec.channel === 'error') return { data: null, error: { code: 'BOOM', message: 'x' } };
      if (spec.channel === 'null') return { data: null, error: null };
      const config = spec.channel === 'invalidConfig' ? { type: 'voice' } : CONFIG;
      return { data: { config, agent_id: spec.agent === null ? null : 'agent-1' }, error: null };
    }
    if (table === 'organizations') return { data: { name: 'Testfirma' }, error: null };
    if (table === 'conversations') {
      return { data: { contact_id: 'contact-1', contacts: { name: 'Kai' } }, error: null };
    }
    if (table === 'agents') return { data: spec.agent ?? null, error: null };
    if (table === 'agent_knowledge_bases') {
      return { data: (spec.kbLinks ?? []).map((id) => ({ knowledge_base_id: id })), error: null };
    }
    return { data: null, error: null };
  };
}

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 2000): Promise<T> {
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
    }, 5);
  });
}

const tick = () => new Promise((r) => setTimeout(r, 25));

let handle: { stop: () => Promise<void>; activeSessions: () => number } | null = null;

async function boot(spec: Scenario): Promise<ReturnType<typeof makeFake>> {
  sessionRegistry.constructed = [];
  const fake = makeFake(respondFor(spec));
  dbHolder.client = fake.client;
  handle = startVoiceDispatch(silentLogger);
  await waitFor(() => (fake.ready() ? true : undefined)); // channel subscribed
  return fake;
}

afterEach(async () => {
  await handle?.stop();
  handle = null;
  envHolder.VOICE_MAX_CONCURRENT_CALLS = 10;
});

const payload = (over: Record<string, string> = {}) => ({
  voice_call_id: IDS.voiceCall,
  provider_call_id: 'call-abc',
  org_id: IDS.org,
  channel_id: IDS.channel,
  ...over,
});

describe('startVoiceDispatch', () => {
  it('cleans up orphaned connecting/active calls on boot', async () => {
    const fake = await boot({ channel: 'ok', agent: { identity: null, mode: 'autopilot', is_active: true } });
    const orphan = await waitFor(() =>
      fake.updates.find(
        (u) => u.table === 'voice_calls' && u.patch.ended_reason === 'worker_restart'
      )
    );
    expect(orphan.patch.status).toBe('failed');
  });

  it('claims a ringing call and joins with agent mode "answer" for an autopilot agent', async () => {
    const fake = await boot({
      channel: 'ok',
      agent: { identity: 'Du bist Bea.', mode: 'autopilot', is_active: true },
      kbLinks: ['kb-1', 'kb-2'],
    });
    fake.fireBroadcast(payload());

    const session = await waitFor(() => sessionRegistry.constructed[0]);
    expect((session.agent as { mode: string }).mode).toBe('answer');
    expect((session.agent as { identity: string }).identity).toBe('Du bist Bea.');
    expect((session.agent as { knowledgeBaseIds: string[] }).knowledgeBaseIds).toEqual([
      'kb-1',
      'kb-2',
    ]);
    expect(session.providerCallId).toBe('call-abc');
    // the atomic claim update ringing→connecting was issued
    expect(
      fake.updates.some((u) => u.table === 'voice_calls' && u.patch.status === 'connecting')
    ).toBe(true);
  });

  it('falls back to intake mode for a draft_only agent', async () => {
    const fake = await boot({
      channel: 'ok',
      agent: { identity: null, mode: 'draft_only', is_active: true },
    });
    fake.fireBroadcast(payload());
    const session = await waitFor(() => sessionRegistry.constructed[0]);
    expect((session.agent as { mode: string }).mode).toBe('intake_only');
  });

  it('falls back to intake mode when the channel has no agent', async () => {
    const fake = await boot({ channel: 'ok', agent: null });
    fake.fireBroadcast(payload());
    const session = await waitFor(() => sessionRegistry.constructed[0]);
    expect((session.agent as { mode: string }).mode).toBe('intake_only');
  });

  it('falls back to intake mode for a paused (inactive) agent', async () => {
    const fake = await boot({
      channel: 'ok',
      agent: { identity: null, mode: 'autopilot', is_active: false },
    });
    fake.fireBroadcast(payload());
    const session = await waitFor(() => sessionRegistry.constructed[0]);
    expect((session.agent as { mode: string }).mode).toBe('intake_only');
  });

  it('does nothing when the row is no longer ringing (lost the claim race)', async () => {
    const fake = await boot({ claim: 'empty', channel: 'ok', agent: null });
    fake.fireBroadcast(payload());
    await tick();
    expect(sessionRegistry.constructed).toHaveLength(0);
    // never progressed to loading the channel config
    expect(fake.updates.some((u) => u.patch.status === 'failed' && u.patch.ended_reason === 'invalid_config')).toBe(
      false
    );
  });

  it('fails the call terminally when the channel config is invalid', async () => {
    const fake = await boot({ channel: 'invalidConfig', agent: null });
    fake.fireBroadcast(payload());
    const failed = await waitFor(() =>
      fake.updates.find(
        (u) => u.table === 'voice_calls' && u.patch.ended_reason === 'invalid_config'
      )
    );
    expect(failed.patch.status).toBe('failed');
    expect(sessionRegistry.constructed).toHaveLength(0);
  });

  it('releases the claim back to ringing on a transient context-load error', async () => {
    const fake = await boot({ channel: 'error', agent: null });
    fake.fireBroadcast(payload());
    const release = await waitFor(() =>
      fake.updates.find(
        (u) =>
          u.table === 'voice_calls' &&
          u.patch.status === 'ringing' &&
          u.patch.claimed_at === null
      )
    );
    expect(release).toBeDefined();
    expect(sessionRegistry.constructed).toHaveLength(0);
  });

  it('respects the concurrency cap and does not claim beyond it', async () => {
    envHolder.VOICE_MAX_CONCURRENT_CALLS = 1;
    const fake = await boot({
      channel: 'ok',
      agent: { identity: null, mode: 'autopilot', is_active: true },
    });
    fake.fireBroadcast(payload());
    await waitFor(() => sessionRegistry.constructed[0]); // first call joined (size 1)
    // a second incoming call while at capacity must not spin up a session
    fake.fireBroadcast(payload({ voice_call_id: IDS.voiceCall2, provider_call_id: 'call-def' }));
    await tick();
    expect(sessionRegistry.constructed).toHaveLength(1);
  });

  it('is disabled entirely when XAI_API_KEY is unset', async () => {
    envHolder.XAI_API_KEY = undefined;
    const localHandle = startVoiceDispatch(silentLogger);
    expect(localHandle.activeSessions()).toBe(0);
    await localHandle.stop();
    envHolder.XAI_API_KEY = 'test-key';
  });
});
