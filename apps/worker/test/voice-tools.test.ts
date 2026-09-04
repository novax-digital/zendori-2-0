import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@zendori/core';
import type { VoiceChannelConfig } from '@zendori/channels';
// Type-only import: erased at runtime, so it does not defeat the '@zendori/ai' mock.
import type { ToolContext } from '../src/voice/tools.js';

// The voice function-tools run in the worker with the org_id bound from server
// truth, so RLS-scoped tenant isolation holds. These tests exercise the three
// tool handlers against a fake supabase: kb_search's intake gating + RAG path,
// create_ticket's conversation-as-ticket + contact-gap fill (never overwrite),
// and handoff's transfer-vs-callback branch.

// kb_search calls the real RAG entrypoint — mock it so the test never embeds.
const retrieveMock = vi.fn();
vi.mock('@zendori/ai', () => ({
  retrieveRelevantChunks: retrieveMock,
  EMBEDDING_MODEL: 'text-embedding-3-small',
}));
// Phase 11: the ticket service is exercised in packages/core; here we only pin
// WHEN the voice tools call it and with what.
const ensureTicketMock = vi.fn();
vi.mock('../src/pipeline/tickets.js', () => ({
  ensureTicketForConversation: ensureTicketMock,
}));

// Imported AFTER the mock is registered.
const {
  kbSearchTool,
  createTicketTool,
  handoffTool,
  decideVoiceHandoff,
  KB_MISS_INSTRUCTION,
  KB_MISS_INSTRUCTION_HANDOFF,
  EMAIL_UNCONFIRMED_ERROR,
  EMAIL_INVALID_ERROR,
  EMAIL_DROPPED_NOTE,
  CONFIRM_GATE_MAX_REFUSALS,
  PHONE_UNCONFIRMED_ERROR,
  PHONE_INVALID_ERROR,
  PHONE_DROPPED_NOTE,
  TICKET_CREATED_INSTRUCTION,
  newConfirmGateState,
  newPhoneGateState,
  newTicketState,
  normalizePhone,
  samePhone,
  toE164,
} = await import('../src/voice/tools.js');

// --- fake supabase ---------------------------------------------------------------

interface Recorded {
  inserts: { table: string; row: Record<string, unknown> }[];
  updates: { table: string; patch: Record<string, unknown> }[];
}

/**
 * Chainable thenable fake. `singles` seeds the row returned by a
 * select().…maybeSingle() per table; `updateError` forces the update on a table
 * to return an error (to drive the failure branches).
 */
function makeFake(
  opts: { singles?: Record<string, unknown>; updateError?: Set<string> } = {}
): { client: SupabaseClient } & Recorded {
  const inserts: Recorded['inserts'] = [];
  const updates: Recorded['updates'] = [];
  const singles = opts.singles ?? {};
  const updateError = opts.updateError ?? new Set<string>();

  function makeChain(table: string, kind: 'select' | 'update' | 'insert') {
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            // updates report one affected row so conditional claims
            // (.update()…eq('mode','bot').select('id')) see a successful flip.
            const result =
              kind === 'update'
                ? {
                    data: updateError.has(table) ? null : [{ id: `${table}-row` }],
                    error: updateError.has(table) ? { message: 'update failed' } : null,
                  }
                : { data: [], error: null };
            return (resolve: (v: unknown) => void) => resolve(result);
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return async () => ({ data: singles[table] ?? null, error: null });
          }
          return () => proxy; // eq / in / is / order / limit / select
        },
      }
    );
    return proxy;
  }

  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return makeChain(table, 'insert');
        },
        update(patch: Record<string, unknown>) {
          updates.push({ table, patch });
          return makeChain(table, 'update');
        },
        select() {
          return makeChain(table, 'select');
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, inserts, updates };
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

function ctxWith(
  fake: ReturnType<typeof makeFake>,
  over: Partial<ToolContext> = {}
): ToolContext {
  return {
    supabase: fake.client,
    orgId: 'org-1',
    conversationId: 'conv-1',
    channelId: 'chan-1',
    channelConfig: CONFIG,
    agentMode: 'answer',
    knowledgeBaseIds: null,
    // 0018 defaults: real active agent, toggle on, hours unconfigured.
    handoffEnabled: true,
    // Phase 12 default: live handoff (today's behavior)
    escalationTarget: 'human',
    confidenceThreshold: 0.7,
    // 0027 default: the pre-migration hardcoded behavior
    intakeFields: ['name', 'phone'],
    businessHours: null,
    allowTransfer: true,
    // e-mail gate: fresh per call, caller has spoken once
    callerTurns: 1,
    emailGate: newConfirmGateState(),
    phoneGate: newPhoneGateState(),
    // caller id known unless a test says otherwise
    callerNumber: '+493022334455',
    ticketState: newTicketState(),
    ...over,
  };
}

beforeEach(() => {
  retrieveMock.mockReset();
  ensureTicketMock.mockReset();
  ensureTicketMock.mockResolvedValue({
    id: 'ticket-1',
    number: 1,
    displayId: '#1',
    status: 'open',
    subject: null,
  });
});

// --- kb_search -------------------------------------------------------------------

describe('kbSearchTool', () => {
  it('is gated off in intake_only mode without touching RAG', async () => {
    const fake = makeFake();
    const result = await kbSearchTool(ctxWith(fake, { agentMode: 'intake_only' }), {
      query: 'Lieferzeit',
    });
    expect(result).toEqual({ ok: false, error: 'kb_search ist in diesem Modus nicht verfügbar' });
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments', async () => {
    const fake = makeFake();
    const result = await kbSearchTool(ctxWith(fake), { query: '' });
    expect(result).toEqual({ ok: false, error: 'invalid arguments' });
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it('returns capped chunks, logs an ai_runs row, and disables rerank for latency', async () => {
    retrieveMock.mockResolvedValue({
      matches: [
        { id: 'k1', source_id: 'src-1', content: 'x'.repeat(1000), similarity: 0.8 },
        { id: 'k2', source_id: 'src-2', content: 'kurz', similarity: 0.5 },
      ],
      embedCostUsd: 0.0001,
      searchMode: 'hybrid',
    });
    const fake = makeFake();
    const result = await kbSearchTool(ctxWith(fake, { knowledgeBaseIds: ['kb-9'] }), {
      query: 'Wie lange dauert die Lieferung?',
    });

    expect(result.ok).toBe(true);
    const chunks = (result as { chunks: { content: string; source_id: string }[] }).chunks;
    expect(chunks).toHaveLength(2);
    // 800-char snippet cap
    expect(chunks[0]?.content.length).toBe(800);
    expect(chunks[0]?.source_id).toBe('src-1');

    // voice keeps rerank OFF (latency) and passes the agent's kb scope + 0.3 gate.
    expect(retrieveMock).toHaveBeenCalledWith(
      fake.client,
      'org-1',
      'Wie lange dauert die Lieferung?',
      expect.objectContaining({ rerank: false, minSimilarity: 0.3, knowledgeBaseIds: ['kb-9'] })
    );
    // one ai_runs row for the retrieve step
    const run = fake.inserts.find((i) => i.table === 'ai_runs');
    expect(run?.row.step).toBe('retrieve');
    expect(run?.row.org_id).toBe('org-1');
  });

  it('a miss escalates to handoff_human when handoff is on and the threshold > 0 (§6)', async () => {
    retrieveMock.mockResolvedValue({ matches: [], embedCostUsd: 0.0001, searchMode: 'hybrid' });
    const fake = makeFake();
    const result = await kbSearchTool(ctxWith(fake), { query: 'Gibt es das in Blau?' });
    expect(result).toEqual({ ok: true, chunks: [], instruction: KB_MISS_INSTRUCTION_HANDOFF });
  });

  it('a miss offers the ticket itself when handoff is off OR the threshold is 0', async () => {
    retrieveMock.mockResolvedValue({ matches: [], embedCostUsd: 0.0001, searchMode: 'hybrid' });
    for (const over of [{ handoffEnabled: false }, { confidenceThreshold: 0 }] as const) {
      const fake = makeFake();
      const result = await kbSearchTool(ctxWith(fake, over), { query: 'Gibt es das in Blau?' });
      expect(result).toEqual({ ok: true, chunks: [], instruction: KB_MISS_INSTRUCTION });
    }
  });

  it('a hit carries no instruction (the model just answers)', async () => {
    retrieveMock.mockResolvedValue({
      matches: [{ id: 'k1', source_id: 'src-1', content: 'Ja, in Blau.', similarity: 0.8 }],
      embedCostUsd: 0.0001,
      searchMode: 'hybrid',
    });
    const fake = makeFake();
    const result = await kbSearchTool(ctxWith(fake), { query: 'Gibt es das in Blau?' });
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('instruction');
  });
});

// --- create_ticket ---------------------------------------------------------------

describe('createTicketTool', () => {
  it('sets the subject, fills empty contact gaps, and writes a system message', async () => {
    const fake = makeFake({
      singles: {
        conversations: { contact_id: 'contact-1' },
        contacts: { name: null, email: null, phone: '+493022334455', company: null, callback_phone: null },
      },
    });
    const result = await createTicketTool(ctxWith(fake), {
      subject: 'Rückruf gewünscht',
      description: 'Kunde bittet um Rückruf zur Rechnung.',
      name: 'Kai Beispiel',
      callback_number: '+49 170 1234567',
      callback_confirmed: true,
      email: 'kai@example.com',
      email_confirmed: true,
      company: 'Beispiel GmbH',
    });

    // id-free: the old ticket_ref UUID was read aloud to callers (2026-09-03)
    expect(result).toEqual({ ok: true, instruction: TICKET_CREATED_INSTRUCTION });
    expect(JSON.stringify(result)).not.toContain('conv-1');
    // subject set on the conversation
    expect(
      fake.updates.find((u) => u.table === 'conversations')?.patch.subject
    ).toBe('Rückruf gewünscht');
    // contact gaps filled (all were null); the differing callback number lands
    // in callback_phone (0029), phone (the caller id) is untouched
    const contactPatch = fake.updates.find((u) => u.table === 'contacts')?.patch;
    expect(contactPatch).toEqual({
      name: 'Kai Beispiel',
      email: 'kai@example.com',
      company: 'Beispiel GmbH',
      callback_phone: '+491701234567',
    });
    // structured system message with all provided lines
    const msg = fake.inserts.find((i) => i.table === 'messages');
    expect(msg?.row.sender_type).toBe('system');
    expect(String(msg?.row.content)).toContain('Ticket #1 aufgenommen: Rückruf gewünscht');
    // Phase 11: the ticket row is ensured with the spoken subject/description
    expect(ensureTicketMock).toHaveBeenCalledWith(
      fake.client,
      expect.objectContaining({
        orgId: 'org-1',
        conversationId: 'conv-1',
        origin: 'voice',
        subject: 'Rückruf gewünscht',
        description: 'Kunde bittet um Rückruf zur Rechnung.',
        attachMode: 'gapfill',
      })
    );
    expect(String(msg?.row.content)).toContain('Unternehmen: Beispiel GmbH');
    expect(String(msg?.row.content)).toContain(
      'Rückruf: +491701234567 (abweichend von Anrufnummer +493022334455)'
    );
    expect(String(msg?.row.content)).toContain('E-Mail: kai@example.com');
  });

  it('no stated number + known caller id → "Rückruf unter Anrufnummer", no phone patch', async () => {
    const fake = makeFake({
      singles: {
        conversations: { contact_id: 'contact-1' },
        contacts: { name: 'Kai', email: null, phone: '+493022334455', company: null, callback_phone: null },
      },
    });
    await createTicketTool(ctxWith(fake), { subject: 'Frage', description: 'Text' });
    expect(fake.updates.some((u) => u.table === 'contacts')).toBe(false);
    const msg = fake.inserts.find((i) => i.table === 'messages');
    expect(String(msg?.row.content)).toContain('Rückruf unter Anrufnummer +493022334455');
  });

  it('a stated number equal to the caller id (national vs. +49) needs no confirmation and is not stored twice', async () => {
    const fake = makeFake({
      singles: {
        conversations: { contact_id: 'contact-1' },
        contacts: { name: 'Kai', email: null, phone: '+493022334455', company: null, callback_phone: null },
      },
    });
    const result = await createTicketTool(ctxWith(fake), {
      subject: 'Frage',
      description: 'Text',
      callback_number: '030 / 22 33 44 55',
    });
    expect(result.ok).toBe(true);
    expect(fake.updates.some((u) => u.table === 'contacts')).toBe(false);
    const msg = fake.inserts.find((i) => i.table === 'messages');
    expect(String(msg?.row.content)).toContain('Rückruf unter Anrufnummer +493022334455');
  });

  it('refuses an unconfirmed callback number BEFORE any write (same gate as the e-mail)', async () => {
    const fake = makeFake({
      singles: { conversations: { contact_id: 'contact-1' }, contacts: { name: null, email: null, phone: null } },
    });
    const result = await createTicketTool(ctxWith(fake, { callerNumber: null }), {
      subject: 'Frage',
      description: 'Text',
      callback_number: '0170 1234567',
    });
    expect(result).toEqual({ ok: false, error: PHONE_UNCONFIRMED_ERROR });
    expect(fake.updates).toHaveLength(0);
    expect(fake.inserts).toHaveLength(0);
  });

  it('refuses a confirmed but invalid callback number', async () => {
    const fake = makeFake({
      singles: { conversations: { contact_id: 'contact-1' }, contacts: { name: null, email: null, phone: null } },
    });
    const result = await createTicketTool(ctxWith(fake, { callerNumber: null }), {
      subject: 'Frage',
      description: 'Text',
      callback_number: 'null eins sieben',
      callback_confirmed: true,
    });
    expect(result).toEqual({ ok: false, error: PHONE_INVALID_ERROR });
    expect(fake.updates).toHaveLength(0);
  });

  it(`after ${CONFIRM_GATE_MAX_REFUSALS} refusals the ticket goes through WITHOUT the number`, async () => {
    const fake = makeFake({
      singles: { conversations: { contact_id: 'contact-1' }, contacts: { name: null, email: null, phone: null } },
    });
    const gate = newPhoneGateState();
    const args = { subject: 'Frage', description: 'Text', callback_number: '0170 1234567' };
    for (let i = 1; i < CONFIRM_GATE_MAX_REFUSALS; i += 1) {
      expect((await createTicketTool(ctxWith(fake, { callerNumber: null, phoneGate: gate }), args)).ok).toBe(false);
    }
    const result = await createTicketTool(ctxWith(fake, { callerNumber: null, phoneGate: gate }), args);
    expect(result).toEqual({ ok: true, instruction: TICKET_CREATED_INSTRUCTION + PHONE_DROPPED_NOTE });
    expect(fake.updates.some((u) => u.table === 'contacts')).toBe(false);
  });

  it('anonymous caller: the confirmed number fills the empty phone as E.164 (matches the next SIP From)', async () => {
    const fake = makeFake({
      singles: {
        conversations: { contact_id: 'contact-1' },
        contacts: { name: null, email: null, phone: null, company: null, callback_phone: null },
      },
    });
    await createTicketTool(ctxWith(fake, { callerNumber: null }), {
      subject: 'Frage',
      description: 'Text',
      callback_number: '0170 1234567',
      callback_confirmed: true,
    });
    expect(fake.updates.find((u) => u.table === 'contacts')?.patch).toEqual({ phone: '+491701234567' });
    const msg = fake.inserts.find((i) => i.table === 'messages');
    expect(String(msg?.row.content)).toContain('Rückruf: +491701234567');
    expect(String(msg?.row.content)).not.toContain('abweichend');
  });

  it('anonymous caller: a number THIS call wrote as identity may be corrected by the same call', async () => {
    const gate = newPhoneGateState();
    const first = makeFake({
      singles: { conversations: { contact_id: 'contact-1' }, contacts: { name: null, email: null, phone: null, callback_phone: null } },
    });
    await createTicketTool(ctxWith(first, { callerNumber: null, phoneGate: gate, callerTurns: 1 }), {
      subject: 'Frage',
      description: 'Text',
      callback_number: '0170 2345678', // mis-heard
      callback_confirmed: true,
    });
    expect(gate.identityPhoneWritten).toBe('+491702345678');
    // caller corrects → the contact now carries the mis-heard identity
    const second = makeFake({
      singles: { conversations: { contact_id: 'contact-1' }, contacts: { name: null, email: null, phone: '+491702345678', callback_phone: null } },
    });
    await createTicketTool(ctxWith(second, { callerNumber: null, phoneGate: gate, callerTurns: 2 }), {
      subject: 'Frage',
      description: 'Text',
      callback_number: '0171 2345678',
      callback_confirmed: true,
    });
    // the identity is corrected, NOT parked as a "differing" callback number
    expect(second.updates.find((u) => u.table === 'contacts')?.patch).toEqual({ phone: '+491712345678' });
  });

  it('a later different callback number overwrites callback_phone (latest statement wins)', async () => {
    const fake = makeFake({
      singles: {
        conversations: { contact_id: 'contact-1' },
        contacts: {
          name: 'Kai',
          email: null,
          phone: '+493022334455',
          company: null,
          callback_phone: '+491511111111',
        },
      },
    });
    await createTicketTool(ctxWith(fake), {
      subject: 'Frage',
      description: 'Text',
      callback_number: '0160 9999999',
      callback_confirmed: true,
    });
    expect(fake.updates.find((u) => u.table === 'contacts')?.patch).toEqual({
      callback_phone: '+491609999999',
    });
  });

  it('use_caller_number clears a stale callback_phone so sidebar/HubSpot agree with the ticket line', async () => {
    const fake = makeFake({
      singles: {
        conversations: { contact_id: 'contact-1' },
        contacts: { name: 'Kai', email: null, phone: '+493022334455', company: null, callback_phone: '+491511111111' },
      },
    });
    await createTicketTool(ctxWith(fake), {
      subject: 'Frage',
      description: 'Text',
      use_caller_number: true,
    });
    expect(fake.updates.find((u) => u.table === 'contacts')?.patch).toEqual({ callback_phone: null });
    const msg = fake.inserts.find((i) => i.table === 'messages');
    expect(String(msg?.row.content)).toContain('Rückruf unter Anrufnummer +493022334455');
  });

  it('without the confirmation question (phone not asked) a stale callback_phone is left alone', async () => {
    const fake = makeFake({
      singles: {
        conversations: { contact_id: 'contact-1' },
        contacts: { name: null, email: null, phone: '+493022334455', company: null, callback_phone: '+491511111111' },
      },
    });
    await createTicketTool(ctxWith(fake, { intakeFields: ['name'] }), {
      subject: 'Frage',
      description: 'Text',
      name: 'Kai',
    });
    expect(fake.updates.find((u) => u.table === 'contacts')?.patch).toEqual({ name: 'Kai' });
  });

  it('never overwrites an existing contact name/email/company', async () => {
    const fake = makeFake({
      singles: {
        conversations: { contact_id: 'contact-1' },
        contacts: { name: 'Bestehender Name', email: 'alt@example.com', company: 'Alt GmbH' },
      },
    });
    await createTicketTool(ctxWith(fake), {
      subject: 'Frage',
      description: 'Text',
      name: 'Neuer Name',
      email: 'neu@example.com',
      email_confirmed: true,
      company: 'Neu GmbH',
    });
    // all slots already filled → no contact update at all
    expect(fake.updates.some((u) => u.table === 'contacts')).toBe(false);
  });

  it('refuses a confirmed but syntactically invalid e-mail BEFORE any write', async () => {
    const fake = makeFake({
      singles: {
        conversations: { contact_id: 'contact-1' },
        contacts: { name: null, email: null },
      },
    });
    for (const bad of ['kai [at] example dot com', 'kai.müller@gmx.de', 'kai@gmx']) {
      const result = await createTicketTool(ctxWith(fake), {
        subject: 'Frage',
        description: 'Text',
        email: bad,
        email_confirmed: true,
      });
      expect(result).toEqual({ ok: false, error: EMAIL_INVALID_ERROR });
    }
    expect(fake.updates).toHaveLength(0);
    expect(fake.inserts).toHaveLength(0);
  });

  it('a confirmed retry only counts once the caller spoke after the refusal', async () => {
    const fake = makeFake({
      singles: { conversations: { contact_id: 'contact-1' }, contacts: { name: null, email: null } },
    });
    const gate = newConfirmGateState();
    const args = { subject: 'Frage', description: 'Text', email: 'kai@example.com' };
    // refusal at caller turn 2
    expect(await createTicketTool(ctxWith(fake, { callerTurns: 2, emailGate: gate }), args)).toEqual({
      ok: false,
      error: EMAIL_UNCONFIRMED_ERROR,
    });
    // silent immediate retry with the flag flipped — same caller turn → refused again
    expect(
      await createTicketTool(ctxWith(fake, { callerTurns: 2, emailGate: gate }), {
        ...args,
        email_confirmed: true,
      })
    ).toEqual({ ok: false, error: EMAIL_UNCONFIRMED_ERROR });
    expect(fake.updates).toHaveLength(0);
    // the caller answered (turn 3) → accepted, e-mail stored lowercased
    const ok = await createTicketTool(ctxWith(fake, { callerTurns: 3, emailGate: gate }), {
      ...args,
      email: 'Kai@Example.com',
      email_confirmed: true,
    });
    expect(ok).toEqual({ ok: true, instruction: TICKET_CREATED_INSTRUCTION });
    expect(fake.updates.find((u) => u.table === 'contacts')?.patch.email).toBe('kai@example.com');
  });

  it(`after ${CONFIRM_GATE_MAX_REFUSALS} refusals the ticket goes through WITHOUT the address (loop guard)`, async () => {
    const fake = makeFake({
      singles: { conversations: { contact_id: 'contact-1' }, contacts: { name: null, email: null } },
    });
    const gate = newConfirmGateState();
    const args = { subject: 'Frage', description: 'Text', email: 'kai@example.com' };
    for (let i = 1; i < CONFIRM_GATE_MAX_REFUSALS; i += 1) {
      expect((await createTicketTool(ctxWith(fake, { emailGate: gate }), args)).ok).toBe(false);
    }
    const result = await createTicketTool(ctxWith(fake, { emailGate: gate }), args);
    expect(result).toEqual({ ok: true, instruction: TICKET_CREATED_INSTRUCTION + EMAIL_DROPPED_NOTE });
    // nothing e-mail-ish was written
    expect(fake.updates.some((u) => u.table === 'contacts')).toBe(false);
    const msg = fake.inserts.find((i) => i.table === 'messages');
    expect(String(msg?.row.content)).not.toContain('E-Mail:');
  });

  it('refuses an unconfirmed e-mail BEFORE writing anything (spell-back gate)', async () => {
    const fake = makeFake({
      singles: {
        conversations: { contact_id: 'contact-1' },
        contacts: { name: null, email: null },
      },
    });
    for (const args of [
      { subject: 'Frage', description: 'Text', email: 'kai@example.com' },
      { subject: 'Frage', description: 'Text', email: 'kai@example.com', email_confirmed: false },
    ]) {
      const result = await createTicketTool(ctxWith(fake), args);
      expect(result).toEqual({ ok: false, error: EMAIL_UNCONFIRMED_ERROR });
    }
    // no subject/status flip, no contact patch, no system message
    expect(fake.updates).toHaveLength(0);
    expect(fake.inserts).toHaveLength(0);
  });

  it('a ticket without any e-mail never trips the spell-back gate', async () => {
    const fake = makeFake({
      singles: { conversations: { contact_id: 'contact-1' }, contacts: { name: null, email: null } },
    });
    for (const args of [
      { subject: 'Frage', description: 'Text' },
      { subject: 'Frage', description: 'Text', email: '' },
      { subject: 'Frage', description: 'Text', email: '   ' },
    ]) {
      const result = await createTicketTool(ctxWith(fake), args);
      expect(result.ok).toBe(true);
    }
  });

  it('a second create_ticket in the same call OVERWRITES (caller corrected the intake)', async () => {
    const fake = makeFake({
      singles: { conversations: { contact_id: 'contact-1' }, contacts: { name: null, email: null, phone: null } },
    });
    const ticketState = newTicketState();
    await createTicketTool(ctxWith(fake, { ticketState }), { subject: 'Erst', description: 'a' });
    expect(ticketState.ticketId).toBe('ticket-1');
    await createTicketTool(ctxWith(fake, { ticketState }), { subject: 'Korrigiert', description: 'b' });
    expect(ensureTicketMock).toHaveBeenLastCalledWith(
      fake.client,
      expect.objectContaining({ subject: 'Korrigiert', attachMode: 'overwrite' })
    );
  });

  it('a failed ticket service never fails the tool (system message without id)', async () => {
    ensureTicketMock.mockResolvedValue(null);
    const fake = makeFake({
      singles: { conversations: { contact_id: 'contact-1' }, contacts: { name: null, email: null, phone: null } },
    });
    const result = await createTicketTool(ctxWith(fake), { subject: 'Frage', description: 'Text' });
    expect(result.ok).toBe(true);
    const msg = fake.inserts.find((i) => i.table === 'messages');
    expect(String(msg?.row.content)).toContain('Ticket aufgenommen: Frage');
  });

  it('returns ok:false when the subject update fails', async () => {
    const fake = makeFake({ updateError: new Set(['conversations']) });
    const result = await createTicketTool(ctxWith(fake), {
      subject: 'Frage',
      description: 'Text',
    });
    expect(result).toEqual({ ok: false, error: 'Ticket konnte nicht gespeichert werden' });
    // failed before any contact/message write
    expect(fake.inserts.some((i) => i.table === 'messages')).toBe(false);
  });

  it('rejects invalid arguments', async () => {
    const fake = makeFake();
    const result = await createTicketTool(ctxWith(fake), { subject: '', description: '' });
    expect(result).toEqual({ ok: false, error: 'invalid arguments' });
  });
});

// --- handoff_human ---------------------------------------------------------------

describe('handoffTool', () => {
  it('signals a live transfer when a transferNumber is configured', async () => {
    const fake = makeFake();
    const result = await handoffTool(
      ctxWith(fake, { channelConfig: { ...CONFIG, transferNumber: '+491701112233' } }),
      { reason: 'user_request' }
    );
    expect(result).toEqual({ ok: true, action: 'transfer', transfer_number: '+491701112233' });
    // conversation flipped to human/pending + handoff_event recorded
    expect(
      fake.updates.some(
        (u) => u.table === 'conversations' && u.patch.mode === 'human' && u.patch.status === 'pending'
      )
    ).toBe(true);
    const event = fake.inserts.find((i) => i.table === 'handoff_events');
    expect(event?.row.reason).toBe('user_request');
    // Phase 11: a live transfer is no callback promise → no ticket
    expect(ensureTicketMock).not.toHaveBeenCalled();
  });

  it("target 'ticket': never transfers, never flips mode — callback intake + one callback_ticket event", async () => {
    const fake = makeFake();
    const ticketState = newTicketState();
    const result = await handoffTool(
      ctxWith(fake, {
        escalationTarget: 'ticket',
        ticketState,
        channelConfig: { ...CONFIG, transferNumber: '+491701112233' },
      }),
      { reason: 'user_request' }
    );
    expect(result.ok).toBe(true);
    expect((result as { action: string }).action).toBe('callback');
    const instruction = (result as { instruction: string }).instruction;
    expect(instruction).toContain('versprich keine Verbindung');
    expect(instruction).not.toContain('Live-Transfer');
    // no mode/status flip
    expect(fake.updates.some((u) => u.table === 'conversations')).toBe(false);
    // ticket at the promise, attached within the call
    expect(ensureTicketMock).toHaveBeenCalledWith(
      fake.client,
      expect.objectContaining({ origin: 'voice', attach: 'always', details: expect.objectContaining({ target: 'ticket' }) })
    );
    expect(ticketState.ticketId).toBe('ticket-1');
    const event = fake.inserts.find((i) => i.table === 'handoff_events');
    expect(event?.row).toMatchObject({ reason: 'user_request', outcome: 'callback_ticket' });
  });

  it("target 'ticket' + low confidence with the toggle off is still suppressed", async () => {
    const fake = makeFake();
    const result = await handoffTool(ctxWith(fake, { escalationTarget: 'ticket', handoffEnabled: false }), {
      reason: 'low_confidence',
    });
    expect((result as { action: string }).action).toBe('no_handoff');
    expect(ensureTicketMock).not.toHaveBeenCalled();
  });

  it('offers a callback when no transferNumber is set — and opens the ticket at the promise', async () => {
    const fake = makeFake();
    const ticketState = newTicketState();
    const result = await handoffTool(ctxWith(fake, { ticketState }), { reason: 'low_confidence' });
    expect(result.ok).toBe(true);
    expect((result as { action: string }).action).toBe('callback');
    // still flips to human and records the event
    expect(fake.inserts.some((i) => i.table === 'handoff_events')).toBe(true);
    // Phase 11 (owner 2026-09-04): the promise itself is the ticket; a caller
    // hanging up mid-intake must not lose it
    expect(ensureTicketMock).toHaveBeenCalledWith(
      fake.client,
      expect.objectContaining({
        origin: 'voice',
        details: { reason: 'low_confidence', outcome: 'callback_ticket' },
      })
    );
    expect(ticketState.ticketId).toBe('ticket-1');
  });

  it('treats a blank transferNumber as no transfer', async () => {
    const fake = makeFake();
    const result = await handoffTool(
      ctxWith(fake, { channelConfig: { ...CONFIG, transferNumber: '   ' } }),
      { reason: 'keyword' }
    );
    expect((result as { action: string }).action).toBe('callback');
  });

  it('returns ok:false when the conversation update fails', async () => {
    const fake = makeFake({ updateError: new Set(['conversations']) });
    const result = await handoffTool(ctxWith(fake), { reason: 'user_request' });
    expect(result).toEqual({ ok: false, error: 'Übergabe fehlgeschlagen' });
    expect(fake.inserts.some((i) => i.table === 'handoff_events')).toBe(false);
  });

  it('rejects an unknown reason', async () => {
    const fake = makeFake();
    const result = await handoffTool(ctxWith(fake), { reason: 'because' });
    expect(result).toEqual({ ok: false, error: 'invalid arguments' });
  });

  // --- 0018: toggle + business hours ------------------------------------------

  it('toggle OFF + low_confidence: no mode flip, suppressed event, no_handoff instruction', async () => {
    const fake = makeFake();
    const result = await handoffTool(
      ctxWith(fake, {
        handoffEnabled: false,
        channelConfig: { ...CONFIG, transferNumber: '+491701112233' },
      }),
      { reason: 'low_confidence' }
    );
    expect((result as { action: string }).action).toBe('no_handoff');
    // conversation untouched, but the suppression is countable
    expect(fake.updates.some((u) => u.table === 'conversations')).toBe(false);
    const event = fake.inserts.find((i) => i.table === 'handoff_events');
    expect(event?.row.outcome).toBe('suppressed');
  });

  it('toggle OFF still transfers on user_request (never stonewall a human wish)', async () => {
    const fake = makeFake();
    const result = await handoffTool(
      ctxWith(fake, {
        handoffEnabled: false,
        channelConfig: { ...CONFIG, transferNumber: '+491701112233' },
      }),
      { reason: 'user_request' }
    );
    expect((result as { action: string }).action).toBe('transfer');
  });

  it('outside business hours: callback instead of transfer, with honest wording', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-22T20:00:00Z') }); // Mi 22:00 Berlin
    try {
      const fake = makeFake();
      const result = await handoffTool(
        ctxWith(fake, {
          businessHours: {
            timezone: 'Europe/Berlin',
            hours: { mon: null, tue: null, wed: { open: '08:00', close: '17:00' }, thu: null, fri: null, sat: null, sun: null },
          },
          channelConfig: { ...CONFIG, transferNumber: '+491701112233' },
        }),
        { reason: 'user_request' }
      );
      expect((result as { action: string }).action).toBe('callback');
      expect((result as { instruction: string }).instruction).toContain('Geschäftszeiten');
      const event = fake.inserts.find((i) => i.table === 'handoff_events');
      expect(event?.row.outcome).toBe('callback_ticket');
    } finally {
      vi.useRealTimers();
    }
  });

  it('agent-less fallback (allowTransfer=false) never transfers even with a number', async () => {
    const fake = makeFake();
    const result = await handoffTool(
      ctxWith(fake, {
        allowTransfer: false,
        channelConfig: { ...CONFIG, transferNumber: '+491701112233' },
      }),
      { reason: 'user_request' }
    );
    expect((result as { action: string }).action).toBe('callback');
  });
});

// --- decideVoiceHandoff (pure matrix) ---------------------------------------------

describe('decideVoiceHandoff', () => {
  it("target 'ticket' returns 'ticket' even with a number within hours; suppression still wins", () => {
    const base = {
      handoffEnabled: true,
      allowTransfer: true,
      transferNumber: '+491701112233',
      businessHours: null,
      now: new Date('2026-09-07T10:00:00+02:00'),
    };
    expect(decideVoiceHandoff({ ...base, reason: 'keyword', escalationTarget: 'ticket' })).toBe('ticket');
    expect(decideVoiceHandoff({ ...base, reason: 'user_request', escalationTarget: 'ticket' })).toBe('ticket');
    expect(
      decideVoiceHandoff({ ...base, reason: 'low_confidence', handoffEnabled: false, escalationTarget: 'ticket' })
    ).toBe('suppress');
    expect(decideVoiceHandoff({ ...base, reason: 'keyword', escalationTarget: 'human' })).toBe('transfer');
  });

  const HOURS = {
    timezone: 'Europe/Berlin',
    hours: {
      mon: null,
      tue: null,
      wed: { open: '08:00', close: '17:00' },
      thu: null,
      fri: null,
      sat: null,
      sun: null,
    },
  };
  const WITHIN = new Date('2026-07-22T08:00:00Z'); // Mi 10:00 Berlin (CEST)
  const OUTSIDE = new Date('2026-07-22T20:00:00Z'); // Mi 22:00 Berlin

  const base = {
    reason: 'user_request' as const,
    handoffEnabled: true,
    allowTransfer: true,
    transferNumber: '+491701112233',
    businessHours: HOURS,
    now: WITHIN,
  };

  it('transfers within hours with a number', () => {
    expect(decideVoiceHandoff(base)).toBe('transfer');
  });

  it('falls back to callback outside hours', () => {
    expect(decideVoiceHandoff({ ...base, now: OUTSIDE })).toBe('callback');
  });

  it('unconfigured hours (null or zero weekdays) allow the transfer — the number is the opt-in', () => {
    expect(decideVoiceHandoff({ ...base, businessHours: null, now: OUTSIDE })).toBe('transfer');
    expect(
      decideVoiceHandoff({
        ...base,
        businessHours: { timezone: 'Europe/Berlin', hours: {} },
        now: OUTSIDE,
      })
    ).toBe('transfer');
  });

  it('suppresses ONLY low_confidence when the toggle is off', () => {
    expect(decideVoiceHandoff({ ...base, handoffEnabled: false, reason: 'low_confidence' })).toBe(
      'suppress'
    );
    expect(decideVoiceHandoff({ ...base, handoffEnabled: false, reason: 'user_request' })).toBe(
      'transfer'
    );
    expect(decideVoiceHandoff({ ...base, handoffEnabled: false, reason: 'keyword' })).toBe(
      'transfer'
    );
  });

  it('no number or no transfer permission → callback', () => {
    expect(decideVoiceHandoff({ ...base, transferNumber: undefined })).toBe('callback');
    expect(decideVoiceHandoff({ ...base, transferNumber: '   ' })).toBe('callback');
    expect(decideVoiceHandoff({ ...base, allowTransfer: false })).toBe('callback');
  });
});

describe('normalizePhone / toE164 / samePhone', () => {
  it('compacts spoken formatting and keeps the leading +', () => {
    expect(normalizePhone('+49 170 / 123-4567')).toBe('+491701234567');
    expect(normalizePhone('0170 1234567')).toBe('01701234567');
    expect(normalizePhone('0049 170 1234567')).toBe('+491701234567');
  });
  it('drops the written/spoken trunk zero after +49', () => {
    expect(normalizePhone('+49 (0) 170 1234567')).toBe('+491701234567');
    expect(normalizePhone('+49 0170 1234567')).toBe('+491701234567');
  });
  it('toE164 uses the channel country code for national numbers', () => {
    expect(toE164('01701234567', '+493022334455')).toBe('+491701234567');
    expect(toE164('0791234567', '+41442223344')).toBe('+41791234567');
    expect(toE164('+41791234567', '+493022334455')).toBe('+41791234567');
    expect(toE164('01701234567', undefined)).toBe('+491701234567');
  });
  it('samePhone is country-aware', () => {
    expect(samePhone('0791234567', '+41791234567', '+41442223344')).toBe(true);
    expect(samePhone('0170 1234567', '+491701234567', '+493022334455')).toBe(true);
    expect(samePhone('0170 1234567', '+491701234568', '+493022334455')).toBe(false);
  });
  it('rejects non-numbers', () => {
    expect(normalizePhone('keine')).toBeUndefined();
    expect(normalizePhone('12')).toBeUndefined();
    expect(normalizePhone(undefined)).toBeUndefined();
  });
});
