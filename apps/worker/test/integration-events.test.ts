import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_EVENT_MAX_ATTEMPTS,
  createLogger,
  encryptSecret,
  verifyStandardWebhook,
} from '@zendori/core';
import {
  buildEventPayload,
  deliverIntegrationEvent,
  pruneIntegrationEvents,
} from '../src/actions/events.js';
import type { ActionDeps } from '../src/actions/execute.js';
import { createMemoryDb, type MemoryDb } from './memory-supabase.js';

// Phase 13c: outbox delivery. Pins the at-least-once contract (stable event id,
// lease against double sends, backoff in the row), that the payload carries the
// current record without message bodies, and that hopeless events stop at once.

const ORG = 'org-1';
const CONN = 'conn-1';
const MASTER_KEY = Buffer.alloc(32, 3).toString('base64');
const SIGNING_SECRET = `whsec_${Buffer.alloc(32, 5).toString('base64')}`;
const logger = createLogger('test', 'silent');

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function recordingFetch(calls: Call[], response: () => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return response();
  }) as typeof fetch;
}

const past = () => new Date(Date.now() - 1_000).toISOString();

async function seed(
  eventPatch: Record<string, unknown> = {},
  connectionPatch: Record<string, unknown> = {}
): Promise<MemoryDb> {
  return createMemoryDb({
    api_connections: [
      {
        id: CONN,
        org_id: ORG,
        is_active: true,
        event_url: 'https://erp.example.com/hooks/zendori',
        config: {
          auth: { kind: 'bearer', secret_encrypted: await encryptSecret('erp-token', MASTER_KEY) },
          signing_secret_encrypted: await encryptSecret(SIGNING_SECRET, MASTER_KEY),
        },
        ...connectionPatch,
      },
    ],
    integration_events: [
      {
        id: 'event-1',
        org_id: ORG,
        connection_id: CONN,
        event_type: 'ticket.updated',
        entity_type: 'ticket',
        entity_id: 'ticket-1',
        details: { changed: ['status'], status_from: 'open', status_to: 'resolved' },
        state: 'pending',
        attempts: 0,
        next_attempt_at: past(),
        created_at: '2026-11-20T10:00:00.000Z',
        ...eventPatch,
      },
    ],
    tickets: [
      {
        id: 'ticket-1',
        org_id: ORG,
        display_id: 'ZD-2026-0042',
        number: 42,
        subject: 'Wallbox lädt nicht',
        description: 'Seit gestern keine Ladung.',
        category: 'Störung',
        status: 'resolved',
        priority: 'high',
        origin: 'handoff',
        conversation_id: 'conv-1',
        channel_id: 'chan-1',
        contact_id: 'contact-1',
        assignee_id: null,
        opened_at: '2026-11-19T08:00:00.000Z',
        resolved_at: '2026-11-20T09:59:00.000Z',
      },
    ],
    conversations: [
      {
        id: 'conv-1',
        org_id: ORG,
        subject: 'Wallbox',
        status: 'pending',
        mode: 'human',
        priority: 'high',
        assignee_id: null,
        channel_id: 'chan-1',
        contact_id: 'contact-1',
        last_message_at: '2026-11-20T09:00:00.000Z',
        created_at: '2026-11-19T08:00:00.000Z',
      },
    ],
    channels: [{ id: 'chan-1', org_id: ORG, type: 'email', name: 'Support-Postfach' }],
    contacts: [
      {
        id: 'contact-1',
        org_id: ORG,
        name: 'Kai Beispiel',
        email: 'kai@example.com',
        phone: '+4915112345678',
        company: 'Beispiel GmbH',
      },
    ],
    external_links: [
      {
        connection_id: CONN,
        entity_type: 'ticket',
        entity_id: 'ticket-1',
        external_id: 'ERP-9001',
      },
    ],
    messages: [
      { id: 'msg-1', org_id: ORG, conversation_id: 'conv-1', content: 'GEHEIMER NACHRICHTENTEXT' },
    ],
  });
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

const event = (db: MemoryDb) => db.rows('integration_events')[0] as Record<string, unknown>;

describe('deliverIntegrationEvent', () => {
  it('posts the signed event with the current ticket and marks it sent', async () => {
    const db = await seed();
    const calls: Call[] = [];
    await deliverIntegrationEvent(
      deps(
        db,
        recordingFetch(calls, () => new Response(null, { status: 204 }))
      ),
      'event-1'
    );

    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe('https://erp.example.com/hooks/zendori');
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe('Bearer erp-token');
    // the event id is the delivery id — stable across retries, so the receiver can dedupe
    expect(call.headers.get('webhook-id')).toBe('event-1');
    expect(call.headers.get('idempotency-key')).toBe('event-1');
    expect(() =>
      verifyStandardWebhook(
        call.body,
        {
          id: call.headers.get('webhook-id'),
          timestamp: call.headers.get('webhook-timestamp'),
          signature: call.headers.get('webhook-signature'),
        },
        SIGNING_SECRET
      )
    ).not.toThrow();

    const payload = JSON.parse(call.body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      id: 'event-1',
      type: 'ticket.updated',
      org_id: ORG,
      created_at: '2026-11-20T10:00:00.000Z',
      changes: { changed: ['status'], status_from: 'open', status_to: 'resolved' },
      data: {
        ticket: {
          id: 'ticket-1',
          display_id: 'ZD-2026-0042',
          status: 'resolved',
          external_id: 'ERP-9001',
          contact: {
            id: 'contact-1',
            email: 'kai@example.com',
            company: 'Beispiel GmbH',
            external_id: null,
          },
        },
      },
    });
    // message bodies never leave through events
    expect(call.body).not.toContain('GEHEIMER NACHRICHTENTEXT');

    expect(event(db)).toMatchObject({
      state: 'sent',
      attempts: 1,
      last_status: 204,
      last_error: null,
    });
    expect(event(db).sent_at).toBeTruthy();
  });

  it('delivers a conversation event with channel and contact', async () => {
    const db = await seed({
      event_type: 'conversation.updated',
      entity_type: 'conversation',
      entity_id: 'conv-1',
    });
    const calls: Call[] = [];
    await deliverIntegrationEvent(
      deps(
        db,
        recordingFetch(calls, () => new Response('{}', { status: 200 }))
      ),
      'event-1'
    );
    const payload = JSON.parse((calls[0] as Call).body) as {
      data: { conversation: Record<string, unknown> };
    };
    expect(payload.data.conversation).toMatchObject({
      id: 'conv-1',
      mode: 'human',
      channel: { id: 'chan-1', type: 'email', name: 'Support-Postfach' },
      contact: { name: 'Kai Beispiel' },
    });
  });

  it('a ping has no record', async () => {
    const db = await seed({
      event_type: 'ping',
      entity_type: 'ping',
      entity_id: null,
      details: {},
    });
    const calls: Call[] = [];
    await deliverIntegrationEvent(
      deps(
        db,
        recordingFetch(calls, () => new Response('ok', { status: 200 }))
      ),
      'event-1'
    );
    expect(JSON.parse((calls[0] as Call).body)).toMatchObject({
      type: 'ping',
      data: {},
      changes: {},
    });
    expect(event(db)).toMatchObject({ state: 'sent' });
  });

  it('reschedules after an error status and keeps the event pending', async () => {
    const db = await seed();
    const before = Date.now();
    await deliverIntegrationEvent(
      deps(
        db,
        recordingFetch([], () => new Response('down', { status: 503 }))
      ),
      'event-1'
    );
    const row = event(db);
    expect(row).toMatchObject({
      state: 'pending',
      attempts: 1,
      last_status: 503,
      last_error: 'http_error',
    });
    const delay = Date.parse(row.next_attempt_at as string) - before;
    expect(delay).toBeGreaterThanOrEqual(59_000);
    expect(delay).toBeLessThan(70_000);
  });

  it('reschedules after a transport failure', async () => {
    const db = await seed();
    await deliverIntegrationEvent(
      deps(db, (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch),
      'event-1'
    );
    expect(event(db)).toMatchObject({
      state: 'pending',
      attempts: 1,
      last_status: null,
      last_error: 'network',
    });
  });

  it('gives up after the last attempt', async () => {
    const db = await seed({ attempts: INTEGRATION_EVENT_MAX_ATTEMPTS - 1 });
    await deliverIntegrationEvent(
      deps(
        db,
        recordingFetch([], () => new Response('down', { status: 500 }))
      ),
      'event-1'
    );
    expect(event(db)).toMatchObject({
      state: 'failed',
      attempts: INTEGRATION_EVENT_MAX_ATTEMPTS,
      last_status: 500,
    });
  });

  it('does not send before the event is due', async () => {
    const db = await seed({ next_attempt_at: new Date(Date.now() + 60_000).toISOString() });
    const calls: Call[] = [];
    await deliverIntegrationEvent(
      deps(
        db,
        recordingFetch(calls, () => new Response('{}'))
      ),
      'event-1'
    );
    expect(calls).toHaveLength(0);
    expect(event(db)).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('a duplicate job for the same event does not send twice', async () => {
    const db = await seed();
    const calls: Call[] = [];
    const d = deps(
      db,
      recordingFetch(calls, () => new Response('{}', { status: 200 }))
    );
    await Promise.all([
      deliverIntegrationEvent(d, 'event-1'),
      deliverIntegrationEvent(d, 'event-1'),
    ]);
    await deliverIntegrationEvent(d, 'event-1');
    expect(calls).toHaveLength(1);
  });

  it('fails at once when the connection is paused or has no event URL', async () => {
    for (const patch of [{ is_active: false }, { event_url: null }]) {
      const db = await seed({}, patch);
      const calls: Call[] = [];
      await deliverIntegrationEvent(
        deps(
          db,
          recordingFetch(calls, () => new Response('{}'))
        ),
        'event-1'
      );
      expect(calls).toHaveLength(0);
      expect(event(db)).toMatchObject({ state: 'failed', last_error: 'connection_inactive' });
    }
  });

  it('fails at once when the record was deleted in the meantime', async () => {
    const db = await seed();
    db.tables.tickets = [];
    const calls: Call[] = [];
    await deliverIntegrationEvent(
      deps(
        db,
        recordingFetch(calls, () => new Response('{}'))
      ),
      'event-1'
    );
    expect(calls).toHaveLength(0);
    expect(event(db)).toMatchObject({ state: 'failed', last_error: 'entity_gone' });
  });

  it('never delivers to an address the SSRF guard rejects', async () => {
    const db = await seed();
    const calls: Call[] = [];
    await deliverIntegrationEvent(
      {
        ...deps(
          db,
          recordingFetch(calls, () => new Response('{}'))
        ),
        assertUrl: async () => {
          throw new Error('private');
        },
      },
      'event-1'
    );
    expect(calls).toHaveLength(0);
    expect(event(db)).toMatchObject({ state: 'pending', last_error: 'blocked_url' });
  });
});

describe('buildEventPayload', () => {
  it('tolerates malformed details', () => {
    const payload = buildEventPayload(
      { id: 'e', event_type: 'contact.updated', created_at: 'now', org_id: ORG, details: 'broken' },
      { contact: { id: 'c' } }
    );
    expect(payload.changes).toEqual({});
  });
});

describe('pruneIntegrationEvents', () => {
  it('removes old delivered and given-up events, keeps pending and recent ones', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString();
    const db = createMemoryDb({
      integration_events: [
        { id: 'old-sent', state: 'sent', created_at: old },
        { id: 'old-failed', state: 'failed', created_at: old },
        { id: 'old-pending', state: 'pending', created_at: old },
        { id: 'new-sent', state: 'sent', created_at: new Date().toISOString() },
      ],
    });
    await pruneIntegrationEvents(db.client);
    expect(
      db
        .rows('integration_events')
        .map((r) => r.id)
        .sort()
    ).toEqual(['new-sent', 'old-pending']);
  });
});
