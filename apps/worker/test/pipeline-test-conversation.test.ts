import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@zendori/core';

// Test conversations (migration 0050): a chat channel is tried out on its own
// "Test" tab. The pipeline runs the same chain as for a customer, with three
// differences these tests pin down: the assigned agent answers even while it is
// paused or only writes drafts, no ticket is opened, and HubSpot is never asked.
// The AI boundary and the service client are mocked; ensureTicket and the
// handoff rules are the real ones.

const { classifyMock, draftMock, prepareActionsMock, dbHolder } = vi.hoisted(() => ({
  classifyMock: vi.fn(),
  draftMock: vi.fn(),
  prepareActionsMock: vi.fn(),
  dbHolder: { client: undefined as unknown },
}));

vi.mock('@zendori/ai', () => ({
  AI_MODELS: { classify: 'claude-haiku-4-5', draft: 'claude-sonnet-4-6' },
  EMBEDDING_MODEL: 'text-embedding-3-small',
  TRANSCRIBE_MODEL: 'whisper-1',
  classify: classifyMock,
  draft: draftMock,
  extract: vi.fn(),
  transcribeAudio: vi.fn(),
  retrieveRelevantChunks: async () => ({
    matches: [],
    embedCostUsd: 0,
    searchMode: 'hybrid',
    rerank: null,
    rerankFailed: false,
  }),
}));
vi.mock('@zendori/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const silent = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return silent;
    },
  };
  return { ...actual, createLogger: () => silent };
});
vi.mock('../src/db.js', () => ({
  getServiceClient: () => dbHolder.client,
  toErrorInfo: (e: unknown) => ({ name: 'e', message: String(e) }),
  isMissingColumnError: (e: unknown) =>
    (e as { code?: string } | null)?.code === '42703' ||
    (e as { code?: string } | null)?.code === 'PGRST204',
}));
// no released files in these scenarios; data actions are prepared by a mock
// (null = the agent has none) so the tests can see WHICH mode they are prepared in
vi.mock('../src/pipeline/draft-actions.js', () => ({ prepareDraftActions: prepareActionsMock }));
vi.mock('../src/pipeline/outbound-files.js', () => ({
  resolveReleasedFiles: async () => [],
  loadReleasedFiles: async () => [],
  persistOutboundAttachments: async () => [],
}));

const { processMessage } = await import('../src/pipeline/process-message.js');

// --- fake supabase ---------------------------------------------------------------

interface Scenario {
  isTest: boolean;
  /** null = no agent assigned to the channel */
  agent: {
    mode: 'draft_only' | 'autopilot' | 'intake_only';
    is_active: boolean;
    escalation_target?: 'human' | 'ticket';
  } | null;
  /** the conversation already carries a system notice (a confirmation was sent) */
  systemReplyBefore?: boolean;
  /** conversations.is_test does not exist yet (worker ahead of 0050) */
  pre0050?: boolean;
}

interface Recorded {
  inserts: { table: string; row: Record<string, unknown> }[];
  updates: { table: string; patch: Record<string, unknown> }[];
  /** every table a query was started on, in order */
  touched: string[];
}

function makeFake(scenario: Scenario): { client: SupabaseClient } & Recorded {
  const inserts: Recorded['inserts'] = [];
  const updates: Recorded['updates'] = [];
  const touched: string[] = [];
  let messageLoads = 0;

  const message = {
    id: 'msg-1',
    org_id: 'org-1',
    conversation_id: 'conv-1',
    channel_id: 'chan-1',
    direction: 'in',
    sender_type: 'contact',
    content: 'Wie lange dauert der Versand?',
    content_type: 'text',
    external_id: 'widget-1',
    metadata: {},
    processing_state: 'pending',
    created_at: new Date().toISOString(),
    conversation: {
      id: 'conv-1',
      org_id: 'org-1',
      mode: 'bot',
      priority: 'normal',
      contact_id: null,
      subject: null,
      ...(scenario.pre0050 ? {} : { is_test: scenario.isTest }),
    },
    channel: { id: 'chan-1', type: 'chat', name: 'Website-Chat', agent_id: scenario.agent ? 'agent-1' : null },
  };

  function one(table: string, kind: string, columns: string): { data: unknown; error: unknown } {
    if (table === 'messages' && kind === 'select') {
      messageLoads += 1;
      if (scenario.pre0050 && columns.includes('is_test')) {
        return { data: null, error: { code: '42703' } };
      }
      return { data: message, error: null };
    }
    if (table === 'messages' && kind === 'insert') return { data: { id: 'out-1' }, error: null };
    if (table === 'organizations') return { data: { name: 'Acme GmbH' }, error: null };
    if (table === 'agents') {
      return {
        data: scenario.agent && {
          id: 'agent-1',
          name: 'Support',
          identity: null,
          confidence_threshold: 0.7,
          handoff_enabled: true,
          escalation_target: 'human',
          ...scenario.agent,
        },
        error: null,
      };
    }
    if (table === 'org_settings') {
      return {
        data: { escalation_keywords: [], auto_ack_texts: {}, business_hours: null, ticket_ack_texts: {} },
        error: null,
      };
    }
    if (table === 'conversations') {
      if (scenario.pre0050 && columns.includes('is_test')) {
        return { data: null, error: { code: '42703' } };
      }
      return { data: { mode: 'bot', contact_id: null, is_test: scenario.isTest }, error: null };
    }
    if (table === 'channels') {
      return {
        data: scenario.agent
          ? { agent_id: 'agent-1', agent: { mode: scenario.agent.mode, is_active: scenario.agent.is_active } }
          : { agent_id: null, agent: null },
        error: null,
      };
    }
    if (table === 'tickets' && kind === 'insert') {
      return {
        data: { id: 't-1', number: 1, display_id: '#1', status: 'open', subject: null, channel_id: 'chan-1' },
        error: null,
      };
    }
    return { data: null, error: null };
  }

  function many(table: string, kind: string, filters: [string, unknown][]): { data: unknown; error: null } {
    // claimMessageDone: the conditional update returns the one row it flipped
    if (table === 'messages' && kind === 'update') return { data: [{ id: 'msg-1' }], error: null };
    // hasSystemReply
    if (
      table === 'messages' &&
      kind === 'select' &&
      filters.some(([column, value]) => column === 'sender_type' && value === 'system')
    ) {
      return { data: scenario.systemReplyBefore ? [{ id: 'sys-0' }] : [], error: null };
    }
    return { data: [], error: null };
  }

  function chain(table: string, kind: string, columns = ''): unknown {
    const filters: [string, unknown][] = [];
    let selected = columns;
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'then') {
            return (resolve: (value: unknown) => void) => resolve(many(table, kind, filters));
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return async () => one(table, kind, selected);
          }
          if (prop === 'select') {
            return (cols?: string) => {
              if (kind === 'select') selected = cols ?? '';
              return proxy;
            };
          }
          if (prop === 'eq') {
            return (column: string, value: unknown) => {
              filters.push([column, value]);
              return proxy;
            };
          }
          return () => proxy;
        },
      }
    );
    return proxy;
  }

  const client = {
    from(table: string) {
      touched.push(table);
      return {
        select: (columns?: string) => chain(table, 'select', columns ?? ''),
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return chain(table, 'insert');
        },
        update(patch: Record<string, unknown>) {
          updates.push({ table, patch });
          return chain(table, 'update');
        },
        delete: () => chain(table, 'delete'),
      };
    },
  } as unknown as SupabaseClient;
  void messageLoads;
  return { client, inserts, updates, touched };
}

const CLASSIFICATION = {
  language: 'de',
  intent: 'Frage zum Versand',
  priority: 'normal',
  wants_human: false,
  is_spam: false,
  is_auto_reply: false,
  is_new_topic: false,
  summary: 'Frage nach der Lieferzeit.',
};

function outbound(fake: Recorded): Record<string, unknown>[] {
  return fake.inserts
    .filter((i) => i.table === 'messages' && i.row.direction === 'out')
    .map((i) => i.row);
}
function drafts(fake: Recorded): Record<string, unknown>[] {
  return fake.inserts.filter((i) => i.table === 'ai_drafts').map((i) => i.row);
}
function inserted(fake: Recorded, table: string): Record<string, unknown>[] {
  return fake.inserts.filter((i) => i.table === table).map((i) => i.row);
}

async function run(scenario: Scenario, overrides?: { wantsHuman?: boolean; confidence?: number }) {
  classifyMock.mockResolvedValue({
    result: { ...CLASSIFICATION, wants_human: overrides?.wantsHuman === true },
    costUsd: 0.0001,
  });
  draftMock.mockResolvedValue({
    result: {
      reply: 'Der Versand dauert zwei bis drei Werktage.',
      confidence: overrides?.confidence ?? 0.92,
      used_source_ids: [],
    },
    costUsd: 0.002,
    toolCalls: 0,
  });
  const fake = makeFake(scenario);
  dbHolder.client = fake.client;
  await processMessage('msg-1');
  return fake;
}

beforeEach(() => {
  classifyMock.mockReset();
  draftMock.mockReset();
  prepareActionsMock.mockReset();
  prepareActionsMock.mockResolvedValue(null);
});

describe('a test conversation is answered whatever state the agent is in', () => {
  it('an agent that only writes drafts answers directly in the test chat', async () => {
    const fake = await run({ isTest: true, agent: { mode: 'draft_only', is_active: true } });
    expect(outbound(fake)).toEqual([
      expect.objectContaining({
        sender_type: 'bot',
        conversation_id: 'conv-1',
        content: 'Der Versand dauert zwei bis drei Werktage.',
      }),
    ]);
    // the answer went out, so the draft is stored as sent — not as a suggestion
    expect(drafts(fake)).toEqual([expect.objectContaining({ status: 'accepted' })]);
  });

  it('a paused agent answers too', async () => {
    const fake = await run({ isTest: true, agent: { mode: 'autopilot', is_active: false } });
    expect(outbound(fake)).toHaveLength(1);
    expect(outbound(fake)[0]).toMatchObject({ sender_type: 'bot' });
  });

  it('the confidence gate still applies: an unsure answer is handed over, not sent', async () => {
    const fake = await run(
      { isTest: true, agent: { mode: 'draft_only', is_active: true } },
      { confidence: 0.4 }
    );
    expect(outbound(fake).filter((row) => row.sender_type === 'bot')).toEqual([]);
    expect(drafts(fake)).toEqual([expect.objectContaining({ status: 'pending' })]);
    // the conversation waits for a human, exactly as it would for a customer
    expect(fake.updates).toContainEqual({
      table: 'conversations',
      patch: { mode: 'human', status: 'pending' },
    });
  });

  it('without an agent nobody answers — as on the live widget', async () => {
    const fake = await run({ isTest: true, agent: null });
    expect(outbound(fake)).toEqual([]);
    expect(draftMock).not.toHaveBeenCalled();
  });
});

describe('a test conversation leaves no trace outside the inbox', () => {
  const cases: [string, Scenario, { wantsHuman?: boolean; confidence?: number }?][] = [
    ['answered', { isTest: true, agent: { mode: 'draft_only', is_active: true } }],
    ['no agent', { isTest: true, agent: null }],
    ['reine Annahme', { isTest: true, agent: { mode: 'intake_only', is_active: true } }],
    ['handed over', { isTest: true, agent: { mode: 'autopilot', is_active: true } }, { wantsHuman: true }],
    [
      'escalated to a ticket',
      { isTest: true, agent: { mode: 'autopilot', is_active: true, escalation_target: 'ticket' } },
      { wantsHuman: true },
    ],
  ];
  for (const [name, scenario, overrides] of cases) {
    it(`${name}: no ticket, no HubSpot request`, async () => {
      const fake = await run(scenario, overrides);
      expect(inserted(fake, 'tickets')).toEqual([]);
      expect(inserted(fake, 'ticket_events')).toEqual([]);
      // HubSpot is not even looked up, and nothing is armed on the conversation
      expect(fake.touched).not.toContain('integrations');
      expect(fake.touched).not.toContain('tickets');
      expect(
        fake.updates.filter((u) => 'hubspot_sync_requested_at' in u.patch)
      ).toEqual([]);
    });
  }
});

describe('data actions in a test', () => {
  const preparedMode = (): unknown =>
    (prepareActionsMock.mock.calls[0]?.[1] as { agent?: { mode?: string } } | undefined)?.agent?.mode;

  it('an autopilot agent is prepared like one that only writes drafts: writes wait for a person', async () => {
    await run({ isTest: true, agent: { mode: 'autopilot', is_active: true } });
    expect(preparedMode()).toBe('draft_only');
  });

  it('in a real conversation the agent keeps its own mode', async () => {
    await run({ isTest: false, agent: { mode: 'autopilot', is_active: true } });
    expect(preparedMode()).toBe('autopilot');
  });

  it('an answer that depends on a waiting action is not sent in the test either', async () => {
    prepareActionsMock.mockResolvedValue({
      tools: [],
      runTool: async () => ({ ok: true, status: 'pending_approval' }),
      stats: { calls: 1, pendingApproval: 1, succeeded: 0, failed: 0 },
    });
    const fake = await run({ isTest: true, agent: { mode: 'autopilot', is_active: true } });
    expect(outbound(fake)).toEqual([]);
    expect(drafts(fake)).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(inserted(fake, 'tickets')).toEqual([]);
  });
});

describe('escalation target "ticket" in a test', () => {
  const scenario: Scenario = {
    isTest: true,
    agent: { mode: 'autopilot', is_active: true, escalation_target: 'ticket' },
  };

  it('shows the ticket confirmation a customer would get, with TEST as the number', async () => {
    const fake = await run(scenario, { wantsHuman: true });
    const system = outbound(fake).filter((row) => row.sender_type === 'system');
    expect(system).toHaveLength(1);
    expect(String(system[0]?.content)).toContain('TEST');
    // no ticket means no promise to count either
    expect(inserted(fake, 'handoff_events')).toEqual([]);
    // the bot stays in control (target "ticket" never flips the mode)
    expect(fake.updates.filter((u) => u.table === 'conversations' && 'mode' in u.patch)).toEqual([]);
  });

  it('confirms once: a later message gets the short follow-up', async () => {
    const first = await run(scenario, { wantsHuman: true });
    const later = await run({ ...scenario, systemReplyBefore: true }, { wantsHuman: true });
    const text = (fake: Recorded): string =>
      String(outbound(fake).find((row) => row.sender_type === 'system')?.content ?? '');
    expect(text(later)).toContain('TEST');
    expect(text(later)).not.toBe(text(first));
  });

  it('"Reine Annahme" stays quiet after the first confirmation', async () => {
    const intake: Scenario = {
      isTest: true,
      agent: { mode: 'intake_only', is_active: true, escalation_target: 'ticket' },
    };
    expect(outbound(await run(intake))).toHaveLength(1);
    expect(outbound(await run({ ...intake, systemReplyBefore: true }))).toEqual([]);
  });
});

describe('a real conversation is unchanged', () => {
  it('an agent that only writes drafts sends nothing and the request becomes a ticket', async () => {
    const fake = await run({ isTest: false, agent: { mode: 'draft_only', is_active: true } });
    expect(outbound(fake)).toEqual([]);
    expect(drafts(fake)).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(inserted(fake, 'tickets')).toEqual([
      expect.objectContaining({ origin: 'draft_only', conversation_id: 'conv-1' }),
    ]);
    // HubSpot rules are consulted as before
    expect(fake.touched).toContain('integrations');
  });

  it('a paused agent does not answer', async () => {
    const fake = await run({ isTest: false, agent: { mode: 'autopilot', is_active: false } });
    expect(outbound(fake)).toEqual([]);
    expect(draftMock).not.toHaveBeenCalled();
  });

  it('a worker that runs ahead of migration 0050 processes messages as before', async () => {
    const fake = await run({ isTest: false, pre0050: true, agent: { mode: 'autopilot', is_active: true } });
    expect(outbound(fake)).toEqual([expect.objectContaining({ sender_type: 'bot' })]);
  });
});
