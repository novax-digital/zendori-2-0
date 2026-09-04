import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@zendori/core';

// Ticket stream → HubSpot (Phase 11b): one Zendori ticket → one HubSpot ticket
// anchored on zendori_ref = tickets.id. Mocks the HubSpot client and the DB;
// pins subject prefix, body assembly, follow-up notes after opened_at, the
// resolved-stage update, the no-op paths, and that the sync never touches
// conversations.status.

const { hubspotMock, dbHolder } = vi.hoisted(() => ({
  hubspotMock: {
    createTicket: vi.fn(),
    findTicketByRef: vi.fn(),
    updateTicketStage: vi.fn(),
    attachNote: vi.fn(),
    upsertContact: vi.fn(),
  },
  dbHolder: { client: undefined as unknown },
}));

vi.mock('@zendori/integrations', () => ({
  createTicket: hubspotMock.createTicket,
  findTicketByRef: hubspotMock.findTicketByRef,
  updateTicketStage: hubspotMock.updateTicketStage,
  attachNote: hubspotMock.attachNote,
  upsertContact: hubspotMock.upsertContact,
}));
vi.mock('@zendori/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const silent = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return silent; } };
  return {
    ...actual,
    createLogger: () => silent,
    loadWorkerEnv: () => ({ MASTER_ENCRYPTION_KEY: 'k' }),
    decryptSecret: async () => 'token',
  };
});
vi.mock('../src/db.js', () => ({
  getServiceClient: () => dbHolder.client,
  toErrorInfo: (e: unknown) => ({ name: 'e', message: String(e) }),
  isMissingColumnError: (e: unknown) =>
    (e as { code?: string } | null)?.code === '42703' ||
    (e as { code?: string } | null)?.code === 'PGRST204',
}));

const { syncTicket, buildTicketSubject } = await import('../src/pipeline/hubspot-sync.js');

// --- fake supabase ---------------------------------------------------------------

interface Recorded {
  inserts: { table: string; row: Record<string, unknown> }[];
  updates: { table: string; patch: Record<string, unknown> }[];
}

/** `singles` per table for maybeSingle(); `lists` per table for awaited selects. */
function makeFake(opts: {
  singles?: Record<string, unknown>;
  lists?: Record<string, unknown[]>;
}): { client: SupabaseClient } & Recorded {
  const inserts: Recorded['inserts'] = [];
  const updates: Recorded['updates'] = [];
  function chain(table: string, kind: 'select' | 'insert' | 'update') {
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            const result =
              kind === 'select'
                ? { data: opts.lists?.[table] ?? [], error: null }
                : { data: [], error: null };
            return (resolve: (v: unknown) => void) => resolve(result);
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return async () => ({ data: opts.singles?.[table] ?? null, error: null });
          }
          return () => proxy;
        },
      }
    );
    return proxy;
  }
  const client = {
    from(table: string) {
      return {
        select: () => chain(table, 'select'),
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return chain(table, 'insert');
        },
        update(patch: Record<string, unknown>) {
          updates.push({ table, patch });
          return chain(table, 'update');
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, inserts, updates };
}

const TICKET = {
  id: 'ticket-1',
  org_id: 'org-1',
  conversation_id: 'conv-1',
  channel_id: 'chan-1',
  contact_id: 'contact-1',
  display_id: 'ZD-2026-0007',
  subject: 'Rechnung fehlt',
  description: 'Kunde vermisst die Juli-Rechnung.',
  status: 'open',
  priority: 'high',
  opened_at: '2026-09-01T10:00:00Z',
  opened_message_id: 'msg-open',
  hubspot_ticket_id: null,
  hubspot_noted_through: null,
  hubspot_synced_at: null,
  channel: { id: 'chan-1', type: 'email', name: 'Support-Mail' },
  conversation: { id: 'conv-1', contact_id: 'contact-1', subject: 'Re: Rechnung' },
};

const INTEGRATION = {
  id: 'int-1',
  config: {
    token_encrypted: 'enc',
    pipeline_id: 'p-conv',
    default_stage_id: 's-conv',
    tickets: { pipeline_id: 'p-tickets', default_stage_id: 's-open', resolved_stage_id: 's-done', subject_prefix: true },
  },
};

const CONTACT = { name: 'Kai Beispiel', email: 'kai@example.com', phone: null, company: null, callback_phone: null };
const OPENING = {
  id: 'msg-open',
  content: 'Hallo, meine Rechnung fehlt.',
  content_type: 'text',
  created_at: '2026-09-01T10:00:00Z',
  metadata: {},
};

function seeds(over: {
  ticket?: Partial<typeof TICKET>;
  integration?: unknown;
  messages?: unknown[];
} = {}) {
  return {
    singles: {
      tickets: { ...TICKET, ...(over.ticket ?? {}) },
      integrations: over.integration === undefined ? INTEGRATION : over.integration,
      contacts: CONTACT,
      messages: OPENING,
    },
    lists: { messages: over.messages ?? [], attachments: [] },
  };
}

beforeEach(() => {
  for (const fn of Object.values(hubspotMock)) fn.mockReset();
  hubspotMock.upsertContact.mockResolvedValue({ id: 'hs-contact' });
  hubspotMock.createTicket.mockResolvedValue({ id: 'hs-ticket-1' });
  hubspotMock.findTicketByRef.mockResolvedValue(null);
});

describe('buildTicketSubject', () => {
  it('prefixes the display id when configured, falls back to the conversation subject', () => {
    expect(buildTicketSubject({ display_id: '#7', subject: 'Frage' }, null, true)).toBe('[#7] Frage');
    expect(buildTicketSubject({ display_id: '#7', subject: 'Frage' }, null, false)).toBe('Frage');
    expect(buildTicketSubject({ display_id: '#7', subject: null }, 'Re: Rechnung', true)).toBe('[#7] Re: Rechnung');
    expect(buildTicketSubject({ display_id: '#7', subject: '  ' }, null, false)).toBe('Ticket');
  });
});

describe('syncTicket', () => {
  it('creates the HubSpot ticket anchored on the ticket id, with prefix, description + opening message', async () => {
    const fake = makeFake(seeds());
    dbHolder.client = fake.client;
    await syncTicket('ticket-1');

    expect(hubspotMock.findTicketByRef).toHaveBeenCalledWith(expect.anything(), 'ticket-1');
    const [, draft] = hubspotMock.createTicket.mock.calls[0]!;
    expect(draft).toMatchObject({
      subject: '[ZD-2026-0007] Rechnung fehlt',
      priority: 'high',
      pipelineId: 'p-tickets',
      stageId: 's-open',
      sourceChannel: 'email',
      ref: 'ticket-1',
    });
    expect(draft.content).toContain('Kunde vermisst die Juli-Rechnung.');
    expect(draft.content).toContain('Hallo, meine Rechnung fehlt.');
    expect(draft.content).toContain('— Zendori-Ticket ZD-2026-0007');
    // hubspot id + watermark + synced stamp land on the TICKET, never on the conversation
    const ticketPatches = fake.updates.filter((u) => u.table === 'tickets').map((u) => u.patch);
    expect(ticketPatches[0]).toMatchObject({ hubspot_ticket_id: 'hs-ticket-1', hubspot_noted_through: OPENING.created_at });
    expect(ticketPatches.some((p) => p.hubspot_synced_at !== undefined)).toBe(true);
    expect(fake.updates.some((u) => u.table === 'conversations')).toBe(false);
    // timeline entry
    expect(fake.inserts.find((i) => i.table === 'ticket_events')?.row).toMatchObject({
      kind: 'hubspot_synced',
      details: { hubspot_ticket_id: 'hs-ticket-1' },
    });
  });

  it('omits the prefix when subject_prefix is off', async () => {
    const fake = makeFake(
      seeds({
        integration: {
          ...INTEGRATION,
          config: { ...INTEGRATION.config, tickets: { ...INTEGRATION.config.tickets, subject_prefix: false } },
        },
      })
    );
    dbHolder.client = fake.client;
    await syncTicket('ticket-1');
    expect(hubspotMock.createTicket.mock.calls[0]![1].subject).toBe('Rechnung fehlt');
  });

  it('existing ticket: no create; resolved → resolved stage; follow-ups after the watermark become notes', async () => {
    hubspotMock.findTicketByRef.mockResolvedValue({ id: 'hs-ticket-1', createdAt: '2026-09-01T10:00:00Z' });
    const fake = makeFake(
      seeds({
        ticket: { status: 'resolved', hubspot_ticket_id: 'hs-ticket-1', hubspot_noted_through: '2026-09-01T10:00:00Z' },
        messages: [
          { id: 'm2', content: 'Noch eine Frage', content_type: 'text', created_at: '2026-09-02T09:00:00Z', metadata: {} },
        ],
      })
    );
    dbHolder.client = fake.client;
    await syncTicket('ticket-1');
    expect(hubspotMock.createTicket).not.toHaveBeenCalled();
    expect(hubspotMock.updateTicketStage).toHaveBeenCalledWith(expect.anything(), 'hs-ticket-1', 's-done');
    expect(hubspotMock.attachNote).toHaveBeenCalledTimes(1);
    expect(hubspotMock.attachNote.mock.calls[0]![2]).toMatchObject({ body: 'Noch eine Frage', sourceChannel: 'email' });
    // watermark advanced on the ticket
    expect(fake.updates.some((u) => u.table === 'tickets' && u.patch.hubspot_noted_through === '2026-09-02T09:00:00Z')).toBe(true);
  });

  it('no active integration / no ticket pipeline / no contact channel → stamp only, no HubSpot calls', async () => {
    const cases = [
      seeds({ integration: null }),
      seeds({ integration: { ...INTEGRATION, config: { token_encrypted: 'enc', pipeline_id: 'p', default_stage_id: 's' } } }),
    ];
    for (const seed of cases) {
      const fake = makeFake(seed);
      dbHolder.client = fake.client;
      await syncTicket('ticket-1');
      expect(hubspotMock.createTicket).not.toHaveBeenCalled();
      expect(fake.updates).toEqual([{ table: 'tickets', patch: expect.objectContaining({ hubspot_synced_at: expect.any(String) }) }]);
    }
    const noContact = makeFake({ ...seeds(), singles: { ...seeds().singles, contacts: { name: 'X', email: null, phone: null, company: null, callback_phone: null } } });
    dbHolder.client = noContact.client;
    await syncTicket('ticket-1');
    expect(hubspotMock.createTicket).not.toHaveBeenCalled();
  });

  it('a vanished ticket is a no-op', async () => {
    const fake = makeFake({ singles: { tickets: null } });
    dbHolder.client = fake.client;
    await syncTicket('ticket-1');
    expect(fake.updates).toHaveLength(0);
    expect(hubspotMock.findTicketByRef).not.toHaveBeenCalled();
  });
});
