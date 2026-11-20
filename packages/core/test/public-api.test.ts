import { describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX,
  apiKeyFromAuthorization,
  generateApiKey,
  hashApiKey,
  looksLikeApiKey,
} from '../src/api-keys.js';
import {
  apiAddNote,
  apiGetContact,
  apiGetConversation,
  apiGetTicket,
  apiPatchContact,
  apiPatchTicket,
  apiPutLink,
  apiWhoAmI,
  authenticateApiKey,
  resolveRecordRef,
  type PublicApiContext,
} from '../src/public-api.js';
import { createMemoryDb, type MemoryDb } from './memory-supabase.js';

// Phase 13d: the public Zendori API. Pins tenant isolation (every lookup is
// scoped to the key's org), the narrow write surface, idempotent notes and the
// external-id addressing an end system relies on for the way back.

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const CONN = 'conn-1';
const TICKET = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const FOREIGN_TICKET = '44444444-4444-4444-8444-444444444444';
const CONTACT_2 = '55555555-5555-4555-8555-555555555555';

const KEY = generateApiKey();
const CTX: PublicApiContext = {
  orgId: ORG,
  connectionId: CONN,
  connectionName: 'ERP',
  keyId: 'key-1',
};

function seed(): MemoryDb {
  return createMemoryDb(
    {
      api_keys: [
        { id: 'key-1', org_id: ORG, connection_id: CONN, key_hash: KEY.hash, revoked_at: null },
      ],
      api_connections: [{ id: CONN, org_id: ORG, name: 'ERP', is_active: true }],
      tickets: [
        {
          id: TICKET,
          org_id: ORG,
          display_id: 'ZD-2026-0042',
          number: 42,
          subject: 'Wallbox lädt nicht',
          description: 'Seit gestern.',
          category: 'Störung',
          status: 'open',
          priority: 'normal',
          origin: 'handoff',
          conversation_id: CONV,
          channel_id: 'chan-1',
          contact_id: CONTACT,
          assignee_id: null,
          opened_at: '2026-11-19T08:00:00.000Z',
          resolved_at: null,
          hubspot_ticket_id: null,
        },
        {
          id: FOREIGN_TICKET,
          org_id: OTHER_ORG,
          status: 'open',
          conversation_id: 'x',
          channel_id: 'y',
          contact_id: null,
        },
      ],
      conversations: [
        {
          id: CONV,
          org_id: ORG,
          subject: 'Wallbox',
          status: 'pending',
          mode: 'human',
          priority: 'normal',
          assignee_id: null,
          channel_id: 'chan-1',
          contact_id: CONTACT,
          last_message_at: '2026-11-20T09:00:00.000Z',
          created_at: '2026-11-19T08:00:00.000Z',
        },
      ],
      channels: [{ id: 'chan-1', org_id: ORG, type: 'email', name: 'Support' }],
      contacts: [
        {
          id: CONTACT,
          org_id: ORG,
          name: 'Kai Beispiel',
          email: 'kai@example.com',
          phone: null,
          company: null,
        },
        {
          id: CONTACT_2,
          org_id: ORG,
          name: 'Anna',
          email: 'anna@example.com',
          phone: null,
          company: null,
        },
      ],
      messages: [{ id: 'm1', org_id: ORG, conversation_id: CONV, content: 'GEHEIMER TEXT' }],
    },
    {
      contacts: [['org_id', 'email']],
      external_links: [
        ['connection_id', 'entity_type', 'entity_id'],
        ['connection_id', 'entity_type', 'external_id'],
      ],
      api_idempotency_keys: [['api_key_id', 'idempotency_key']],
    }
  );
}

describe('api keys', () => {
  it('generates a recognisable key and stores only its hash', () => {
    expect(KEY.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(looksLikeApiKey(KEY.key)).toBe(true);
    expect(KEY.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(KEY.hash).toBe(hashApiKey(KEY.key));
    expect(KEY.prefix).toBe(KEY.key.slice(0, 12));
    expect(generateApiKey().key).not.toBe(KEY.key);
  });

  it('reads the key from a Bearer header only', () => {
    expect(apiKeyFromAuthorization(`Bearer ${KEY.key}`)).toBe(KEY.key);
    expect(apiKeyFromAuthorization(`bearer   ${KEY.key}`)).toBe(KEY.key);
    expect(apiKeyFromAuthorization(KEY.key)).toBeNull();
    expect(apiKeyFromAuthorization('Bearer something-else')).toBeNull();
    expect(apiKeyFromAuthorization(null)).toBeNull();
  });
});

describe('authenticateApiKey', () => {
  it('resolves a valid key to its org and connection', async () => {
    const auth = await authenticateApiKey(seed().client, `Bearer ${KEY.key}`);
    expect(auth).toEqual({ ok: true, context: CTX });
    expect(apiWhoAmI(CTX).body).toEqual({
      data: { org_id: ORG, connection: { id: CONN, name: 'ERP' } },
    });
  });

  it('rejects a missing, unknown or revoked key identically', async () => {
    const db = seed();
    for (const header of [null, 'Bearer nope', `Bearer ${generateApiKey().key}`]) {
      const auth = await authenticateApiKey(db.client, header);
      expect(auth.ok).toBe(false);
      expect(!auth.ok && auth.result.status).toBe(401);
    }
    (db.rows('api_keys')[0] as Record<string, unknown>).revoked_at = new Date().toISOString();
    const revoked = await authenticateApiKey(db.client, `Bearer ${KEY.key}`);
    expect(!revoked.ok && revoked.result.status).toBe(401);
  });

  it('refuses a key of a paused connection', async () => {
    const db = seed();
    (db.rows('api_connections')[0] as Record<string, unknown>).is_active = false;
    const auth = await authenticateApiKey(db.client, `Bearer ${KEY.key}`);
    expect(!auth.ok && auth.result.status).toBe(403);
  });
});

describe('tickets', () => {
  it('returns the ticket with its contact, without message content', async () => {
    const result = await apiGetTicket(seed().client, CTX, TICKET);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      data: {
        ticket: {
          id: TICKET,
          display_id: 'ZD-2026-0042',
          status: 'open',
          external_id: null,
          contact: { id: CONTACT, email: 'kai@example.com' },
        },
      },
    });
    const text = JSON.stringify(result.body);
    expect(text).not.toContain('GEHEIMER TEXT');
    // internal sync state is not part of the contract
    expect(text).not.toContain('hubspot');
  });

  it('never returns or changes a ticket of another org', async () => {
    const db = seed();
    expect((await apiGetTicket(db.client, CTX, FOREIGN_TICKET)).status).toBe(404);
    expect(
      (await apiPatchTicket(db.client, CTX, FOREIGN_TICKET, { status: 'resolved' })).status
    ).toBe(404);
    expect(db.rows('tickets').find((t) => t.id === FOREIGN_TICKET)?.status).toBe('open');
  });

  it('changes status, priority and category — and nothing else', async () => {
    const db = seed();
    const ok = await apiPatchTicket(db.client, CTX, TICKET, {
      status: 'waiting',
      priority: 'high',
      category: null,
    });
    expect(ok.status).toBe(200);
    expect(db.rows('tickets')[0]).toMatchObject({
      status: 'waiting',
      priority: 'high',
      category: null,
    });

    for (const body of [
      {},
      { subject: 'gekapert' },
      { status: 'deleted' },
      { status: 'open', org_id: OTHER_ORG },
      'x',
    ]) {
      const result = await apiPatchTicket(db.client, CTX, TICKET, body);
      expect(result.status).toBe(422);
    }
    expect(db.rows('tickets')[0]).toMatchObject({ subject: 'Wallbox lädt nicht', org_id: ORG });
  });

  it('rejects malformed references', async () => {
    const db = seed();
    expect((await apiGetTicket(db.client, CTX, 'not-a-uuid')).status).toBe(404);
    expect((await apiGetTicket(db.client, CTX, 'ext:')).status).toBe(404);
    expect((await apiGetTicket(db.client, CTX, 'ext:unknown')).status).toBe(404);
  });
});

describe('links and external references', () => {
  it('links an external id and then addresses the record by it', async () => {
    const db = seed();
    const created = await apiPutLink(db.client, CTX, {
      entity_type: 'ticket',
      entity_id: TICKET,
      external_id: 'ERP-9001',
    });
    expect(created.status).toBe(201);
    expect(await resolveRecordRef(db.client, CTX, 'ticket', 'ext:ERP-9001')).toBe(TICKET);

    const viaExternal = await apiPatchTicket(db.client, CTX, 'ext:ERP-9001', {
      status: 'resolved',
    });
    expect(viaExternal.body).toMatchObject({
      data: { ticket: { id: TICKET, status: 'resolved', external_id: 'ERP-9001' } },
    });
  });

  it('is idempotent and lets a record move to a new external id', async () => {
    const db = seed();
    const link = { entity_type: 'contact', entity_id: CONTACT, external_id: 'CUST-7' };
    expect((await apiPutLink(db.client, CTX, link)).status).toBe(201);
    expect((await apiPutLink(db.client, CTX, link)).status).toBe(200);
    expect((await apiPutLink(db.client, CTX, { ...link, external_id: 'CUST-8' })).status).toBe(200);
    expect(db.rows('external_links')).toHaveLength(1);
    expect(db.rows('external_links')[0]).toMatchObject({
      external_id: 'CUST-8',
      org_id: ORG,
      connection_id: CONN,
    });
  });

  it('refuses an external id that already points at another record', async () => {
    const db = seed();
    await apiPutLink(db.client, CTX, {
      entity_type: 'contact',
      entity_id: CONTACT,
      external_id: 'CUST-7',
    });
    const clash = await apiPutLink(db.client, CTX, {
      entity_type: 'contact',
      entity_id: CONTACT_2,
      external_id: 'CUST-7',
    });
    expect(clash.status).toBe(409);
    expect(db.rows('external_links')).toHaveLength(1);
    // a malformed entity id is rejected before any lookup
    const malformed = await apiPutLink(db.client, CTX, {
      entity_type: 'contact',
      entity_id: 'contact-2',
      external_id: 'X',
    });
    expect(malformed.status).toBe(422);
  });

  it('refuses to link a record of another org and resolves links per connection', async () => {
    const db = seed();
    const foreign = await apiPutLink(db.client, CTX, {
      entity_type: 'ticket',
      entity_id: FOREIGN_TICKET,
      external_id: 'X',
    });
    expect(foreign.status).toBe(404);

    await apiPutLink(db.client, CTX, {
      entity_type: 'ticket',
      entity_id: TICKET,
      external_id: 'ERP-1',
    });
    const otherConnection: PublicApiContext = { ...CTX, connectionId: 'conn-2' };
    expect(await resolveRecordRef(db.client, otherConnection, 'ticket', 'ext:ERP-1')).toBeNull();
  });
});

describe('conversations and contacts', () => {
  it('returns a conversation without its messages', async () => {
    const result = await apiGetConversation(seed().client, CTX, CONV);
    expect(result.body).toMatchObject({
      data: {
        conversation: {
          id: CONV,
          mode: 'human',
          channel: { type: 'email' },
          contact: { name: 'Kai Beispiel' },
        },
      },
    });
    expect(JSON.stringify(result.body)).not.toContain('GEHEIMER TEXT');
  });

  it('updates contact master data and normalises the e-mail', async () => {
    const db = seed();
    const result = await apiPatchContact(db.client, CTX, CONTACT, {
      email: ' Kai.NEU@Example.com ',
      phone: '+4915112345678',
    });
    expect(result.status).toBe(200);
    expect(db.rows('contacts')[0]).toMatchObject({
      email: 'kai.neu@example.com',
      phone: '+4915112345678',
    });
    expect((await apiGetContact(db.client, CTX, CONTACT)).body).toMatchObject({
      data: { contact: { email: 'kai.neu@example.com' } },
    });
  });

  it('reports an e-mail that another contact already uses as a conflict', async () => {
    const db = seed();
    const result = await apiPatchContact(db.client, CTX, CONTACT, { email: 'anna@example.com' });
    expect(result.status).toBe(409);
    expect(db.rows('contacts')[0]).toMatchObject({ email: 'kai@example.com' });
  });

  it('rejects unknown fields and invalid values', async () => {
    const db = seed();
    for (const body of [{}, { email: 'kein-at' }, { wa_id: '123' }, { name: '' }]) {
      expect((await apiPatchContact(db.client, CTX, CONTACT, body)).status).toBe(422);
    }
  });
});

describe('notes', () => {
  it('adds an internal note to the ticket conversation, naming the end system', async () => {
    const db = seed();
    const result = await apiAddNote(
      db.client,
      CTX,
      'ticket',
      TICKET,
      { content: 'Ersatzteil bestellt.' },
      null
    );
    expect(result.status).toBe(201);
    expect(db.rows('notes')[0]).toMatchObject({
      org_id: ORG,
      conversation_id: CONV,
      author_id: null,
      content: '[ERP] Ersatzteil bestellt.',
    });
    // the ticket timeline records the note content-free
    expect(db.rows('ticket_events')[0]).toMatchObject({
      ticket_id: TICKET,
      kind: 'note',
      details: { source: 'api', connection_id: CONN },
    });
    // a note is never a message to the customer
    expect(db.rows('messages')).toHaveLength(1);
  });

  it('adds a note to a conversation directly', async () => {
    const db = seed();
    const result = await apiAddNote(
      db.client,
      CTX,
      'conversation',
      CONV,
      { content: 'Hinweis' },
      null
    );
    expect(result.status).toBe(201);
    expect(db.rows('ticket_events')).toHaveLength(0);
  });

  it('replays the first answer for a repeated Idempotency-Key', async () => {
    const db = seed();
    const first = await apiAddNote(
      db.client,
      CTX,
      'ticket',
      TICKET,
      { content: 'Einmal' },
      'req-1'
    );
    const second = await apiAddNote(
      db.client,
      CTX,
      'ticket',
      TICKET,
      { content: 'Einmal' },
      'req-1'
    );
    expect(second).toEqual(first);
    expect(db.rows('notes')).toHaveLength(1);
    // another key is a new request
    await apiAddNote(db.client, CTX, 'ticket', TICKET, { content: 'Zweimal' }, 'req-2');
    expect(db.rows('notes')).toHaveLength(2);
  });

  it('answers 409 while the first request with that key is still running', async () => {
    const db = seed();
    db.rows('api_idempotency_keys').push({
      api_key_id: 'key-1',
      idempotency_key: 'req-1',
      org_id: ORG,
      response_status: 0,
      response_body: {},
    });
    const result = await apiAddNote(db.client, CTX, 'ticket', TICKET, { content: 'x' }, 'req-1');
    expect(result.status).toBe(409);
    expect(db.rows('notes')).toHaveLength(0);
  });

  it('validates the body and the target', async () => {
    const db = seed();
    expect((await apiAddNote(db.client, CTX, 'ticket', TICKET, { content: '' }, null)).status).toBe(
      422
    );
    expect(
      (await apiAddNote(db.client, CTX, 'ticket', TICKET, { content: 'x', author_id: 'u' }, null))
        .status
    ).toBe(422);
    expect(
      (await apiAddNote(db.client, CTX, 'ticket', FOREIGN_TICKET, { content: 'x' }, null)).status
    ).toBe(404);
    expect(
      (await apiAddNote(db.client, CTX, 'conversation', TICKET, { content: 'x' }, null)).status
    ).toBe(404);
    expect(db.rows('notes')).toHaveLength(0);
  });
});
