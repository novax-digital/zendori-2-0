import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ensureTicket,
  findOpenTicket,
  refineOpenTicket,
  shouldAttachToTicket,
} from '../src/ticket-service.js';

// ensureTicket is the ONE creation path (worker + web). These pin the attach
// rule, the race fallback and the schema-skew degrade against a chainable
// fake client (pattern from apps/worker/test/voice-tools.test.ts).

interface Recorded {
  inserts: { table: string; row: Record<string, unknown> }[];
  updates: { table: string; patch: Record<string, unknown> }[];
}

function makeFake(opts: {
  openTicket?: Record<string, unknown> | null;
  insertError?: { code: string; message?: string } | null;
  selectError?: { code: string } | null;
  conversation?: Record<string, unknown> | null;
  /** second findOpenTicket (after a 23505) returns this */
  openTicketAfterRace?: Record<string, unknown> | null;
} = {}): { client: SupabaseClient } & Recorded {
  const inserts: Recorded['inserts'] = [];
  const updates: Recorded['updates'] = [];
  let ticketSelects = 0;

  function chain(table: string, kind: 'select' | 'insert' | 'update', row?: Record<string, unknown>) {
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            // insertError simulates the tickets insert only (23505 on the
            // open-per-conversation index) — event inserts must still succeed
            const result =
              kind === 'insert' && table === 'tickets' && opts.insertError
                ? { data: null, error: opts.insertError }
                : { data: [], error: null };
            return (resolve: (v: unknown) => void) => resolve(result);
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return async () => {
              if (table === 'tickets' && kind === 'select') {
                if (opts.selectError) return { data: null, error: opts.selectError };
                ticketSelects += 1;
                const value =
                  ticketSelects > 1 && opts.openTicketAfterRace !== undefined
                    ? opts.openTicketAfterRace
                    : (opts.openTicket ?? null);
                return { data: value, error: null };
              }
              if (table === 'tickets' && kind === 'insert') {
                if (opts.insertError) return { data: null, error: opts.insertError };
                return {
                  data: { id: 't-new', number: 7, display_id: '#7', status: row?.status, subject: row?.subject },
                  error: null,
                };
              }
              if (table === 'conversations') {
                return { data: opts.conversation ?? { contact_id: 'contact-1' }, error: null };
              }
              return { data: null, error: null };
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
      return {
        select: () => chain(table, 'select'),
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return chain(table, 'insert', row);
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

const OPEN = {
  id: 't-open',
  number: 3,
  display_id: '#3',
  status: 'open',
  subject: 'Anruf von +4930',
  description: null,
  category: null,
  priority: 'normal',
  assignee_id: null,
  contact_id: 'contact-1',
  channel_id: 'chan-1',
  hubspot_ticket_id: null,
  opened_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 h old
  opened_message_id: 'msg-open',
};

const BASE = { orgId: 'org-1', conversationId: 'conv-1' };

describe('ensureTicket — create', () => {
  it('inserts without number/display_id (trigger-assigned) and returns the ref', async () => {
    const fake = makeFake({ openTicket: null });
    const result = await ensureTicket(fake.client, {
      ...BASE,
      origin: 'handoff',
      subject: '  Rechnung  ',
      description: 'Kunde fragt nach Rechnung',
      priority: 'high',
      openedMessageId: 'msg-1',
    });
    expect(result).toEqual({
      outcome: 'created',
      ticket: { id: 't-new', number: 7, displayId: '#7', status: 'open', subject: 'Rechnung' },
    });
    const row = fake.inserts.find((i) => i.table === 'tickets')?.row;
    expect(row).toMatchObject({
      org_id: 'org-1',
      conversation_id: 'conv-1',
      origin: 'handoff',
      subject: 'Rechnung',
      priority: 'high',
      status: 'open',
      opened_message_id: 'msg-1',
      created_by: null,
    });
    expect(row).not.toHaveProperty('number');
    expect(row).not.toHaveProperty('display_id');
  });

  it('an assignee at creation opens the ticket in_progress', async () => {
    const fake = makeFake({ openTicket: null });
    await ensureTicket(fake.client, { ...BASE, origin: 'takeover', assigneeId: 'u-1', createdBy: 'u-1' });
    expect(fake.inserts[0]?.row).toMatchObject({ status: 'in_progress', assignee_id: 'u-1', created_by: 'u-1' });
  });

  it('a lost race (23505) re-reads and attaches instead of failing', async () => {
    const fake = makeFake({
      openTicket: null,
      insertError: { code: '23505' },
      openTicketAfterRace: OPEN,
    });
    const result = await ensureTicket(fake.client, { ...BASE, origin: 'no_agent' });
    expect(result.outcome).toBe('attached');
    expect(fake.inserts.some((i) => i.table === 'ticket_events' && i.row.kind === 'attached')).toBe(true);
  });

  it('degrades to unavailable while 0030 is not applied', async () => {
    for (const code of ['42P01', 'PGRST205']) {
      const fake = makeFake({ selectError: { code } });
      const result = await ensureTicket(fake.client, { ...BASE, origin: 'form' });
      expect(result).toEqual({ outcome: 'unavailable', reason: 'schema_skew' });
      expect(fake.inserts).toHaveLength(0);
    }
  });
});

describe('ensureTicket — attach rule', () => {
  it('fills gaps only, raises priority, never lowers it, and logs an attached event', async () => {
    const fake = makeFake({ openTicket: { ...OPEN, priority: 'high', description: 'vorhanden' } });
    const result = await ensureTicket(fake.client, {
      ...BASE,
      origin: 'handoff',
      subject: 'Echter Betreff',
      description: 'neu',
      category: 'Störung',
      priority: 'normal',
      openedMessageId: 'msg-9',
      details: { reason: 'keyword' },
    });
    expect(result.outcome).toBe('attached');
    const patch = fake.updates.find((u) => u.table === 'tickets')?.patch;
    // placeholder subject replaced, existing description kept, priority not lowered
    expect(patch?.subject).toBe('Echter Betreff');
    expect(patch).not.toHaveProperty('description');
    expect(patch?.category).toBe('Störung');
    expect(patch).not.toHaveProperty('priority');
    expect(patch).toHaveProperty('updated_at');
    const event = fake.inserts.find((i) => i.table === 'ticket_events')?.row;
    expect(event).toMatchObject({
      ticket_id: 't-open',
      kind: 'attached',
      details: { origin: 'handoff', message_id: 'msg-9', reason: 'keyword' },
    });
  });

  it('raises priority upward and promotes open → in_progress when an assignee arrives', async () => {
    const fake = makeFake({ openTicket: OPEN });
    await ensureTicket(fake.client, { ...BASE, origin: 'takeover', priority: 'urgent', assigneeId: 'u-2' });
    const patch = fake.updates.find((u) => u.table === 'tickets')?.patch;
    expect(patch).toMatchObject({ priority: 'urgent', assignee_id: 'u-2', status: 'in_progress' });
  });

  it('overwrite mode replaces subject and description (voice correction)', async () => {
    const fake = makeFake({ openTicket: { ...OPEN, subject: 'Alt', description: 'alt' } });
    await ensureTicket(fake.client, {
      ...BASE,
      origin: 'voice',
      subject: 'Neu',
      description: 'neu',
      attachMode: 'overwrite',
    });
    const patch = fake.updates.find((u) => u.table === 'tickets')?.patch;
    expect(patch).toMatchObject({ subject: 'Neu', description: 'neu' });
  });

  it('refreshes the contact snapshot from the conversation', async () => {
    const fake = makeFake({ openTicket: OPEN, conversation: { contact_id: 'contact-2' } });
    await ensureTicket(fake.client, { ...BASE, origin: 'handoff' });
    expect(fake.updates.find((u) => u.table === 'tickets')?.patch.contact_id).toBe('contact-2');
  });
});

describe('findOpenTicket / refineOpenTicket', () => {
  it('returns null without an open ticket and unavailable on skew', async () => {
    expect(await findOpenTicket(makeFake({ openTicket: null }).client, 'org-1', 'conv-1')).toBeNull();
    expect(await findOpenTicket(makeFake({ selectError: { code: '42P01' } }).client, 'org-1', 'conv-1')).toBe(
      'unavailable'
    );
  });

  it('refine sets priority always and the subject only over a placeholder', async () => {
    const fake = makeFake({ openTicket: OPEN });
    await refineOpenTicket(fake.client, { ...BASE, priority: 'urgent', subject: 'Lieferstatus' });
    expect(fake.updates[0]?.patch).toEqual({ priority: 'urgent', subject: 'Lieferstatus' });

    const kept = makeFake({ openTicket: { ...OPEN, subject: 'Vom Tool gesetzt' } });
    await refineOpenTicket(kept.client, { ...BASE, priority: 'normal', subject: 'Anderes' });
    expect(kept.updates).toHaveLength(0);
  });

  it('refine is a no-op without an open ticket', async () => {
    const fake = makeFake({ openTicket: null });
    await refineOpenTicket(fake.client, { ...BASE, priority: 'urgent' });
    expect(fake.updates).toHaveLength(0);
  });
});

// Attach rule v2 (Phase 12, owner: "a conversation always continues"): a new
// topic or a stale open ticket opens a NEW ticket even while older ones are open.
describe('attach rule v2', () => {
  it('a topic change opens a new ticket although one is open', async () => {
    const fake = makeFake({ openTicket: OPEN });
    const result = await ensureTicket(fake.client, { ...BASE, origin: 'handoff', newTopic: true });
    expect(result.outcome).toBe('created');
    expect(fake.inserts.some((i) => i.table === 'tickets')).toBe(true);
  });

  it('an open ticket older than the 24h window opens a new one; window null keeps attaching', async () => {
    const stale = { ...OPEN, opened_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() };
    const created = await ensureTicket(makeFake({ openTicket: stale }).client, { ...BASE, origin: 'handoff' });
    expect(created.outcome).toBe('created');
    const attached = await ensureTicket(makeFake({ openTicket: stale }).client, {
      ...BASE,
      origin: 'handoff',
      attachWindowHours: null,
    });
    expect(attached.outcome).toBe('attached');
  });

  it("attach:'never' always creates, attach:'always' attaches even on a topic change", async () => {
    const never = await ensureTicket(makeFake({ openTicket: OPEN }).client, { ...BASE, origin: 'form', attach: 'never' });
    expect(never.outcome).toBe('created');
    const always = await ensureTicket(makeFake({ openTicket: OPEN }).client, {
      ...BASE,
      origin: 'voice',
      attach: 'always',
      newTopic: true,
    });
    expect(always.outcome).toBe('attached');
  });

  it('a retry with the same opening message attaches even if re-classified as a new topic', async () => {
    const fake = makeFake({ openTicket: OPEN });
    const result = await ensureTicket(fake.client, {
      ...BASE,
      origin: 'handoff',
      newTopic: true,
      openedMessageId: 'msg-open',
    });
    expect(result.outcome).toBe('attached');
    expect(fake.inserts.find((i) => i.table === 'ticket_events')?.row).toMatchObject({
      details: expect.objectContaining({ new_topic: true, message_id: 'msg-open' }),
    });
  });

  it('shouldAttachToTicket table', () => {
    const now = new Date('2026-09-04T12:00:00Z');
    const fresh = { opened_at: '2026-09-04T10:00:00Z', opened_message_id: 'm1' };
    const old = { opened_at: '2026-09-02T10:00:00Z', opened_message_id: 'm1' };
    expect(shouldAttachToTicket(fresh, {}, now)).toBe(true);
    expect(shouldAttachToTicket(fresh, { newTopic: true }, now)).toBe(false);
    expect(shouldAttachToTicket(old, {}, now)).toBe(false);
    expect(shouldAttachToTicket(old, { attachWindowHours: null }, now)).toBe(true);
    expect(shouldAttachToTicket(old, { attachWindowHours: 72 }, now)).toBe(true);
    expect(shouldAttachToTicket(old, { newTopic: true, openedMessageId: 'm1' }, now)).toBe(true);
    expect(shouldAttachToTicket({ opened_at: 'garbage', opened_message_id: null }, {}, now)).toBe(true);
  });
});
