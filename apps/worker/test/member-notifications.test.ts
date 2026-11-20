import { describe, expect, it } from 'vitest';
import {
  MEMBER_NOTIFICATION_MAX_ATTEMPTS,
  NEW_CONVERSATION_MAX_WAIT_MS,
  NEW_CONVERSATION_RECHECK_MS,
  createLogger,
} from '@zendori/core';
import type { SendEmailParams } from '@zendori/channels';
import {
  MEMBER_NOTIFICATION_RETENTION_MS,
  deliverMemberNotification,
  pruneMemberNotifications,
  type NotifyDeps,
} from '../src/notifications/deliver.js';
import { createMemoryDb, type MemoryDb } from './memory-supabase.js';

// Member notifications (0038): delivery of one queue row. Pins that a mail only
// goes to a member who is still subscribed and may see the record, that spam
// never notifies, that a row is sent at most once, and that the mail carries no
// message text.

const ORG = 'org-1';
const USER = 'user-1';
const CHANNEL = '11111111-1111-4111-8111-111111111111';
const OTHER_CHANNEL = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = 'conv-1';
const TICKET = 'ticket-1';
const NOW = Date.parse('2026-11-20T10:00:00Z');
const logger = createLogger('test', 'silent');

const iso = (ms: number) => new Date(ms).toISOString();

interface Seed {
  notification?: Record<string, unknown>;
  member?: Record<string, unknown> | null;
  events?: string[] | null;
  messages?: Record<string, unknown>[];
  extraNotifications?: Record<string, unknown>[];
}

function seed(options: Seed = {}): MemoryDb {
  return createMemoryDb({
    member_notifications: [
      {
        id: 'n-1',
        org_id: ORG,
        user_id: USER,
        event_type: 'ticket.new',
        entity_type: 'ticket',
        entity_id: TICKET,
        actor_id: null,
        details: {},
        state: 'pending',
        attempts: 0,
        next_attempt_at: iso(NOW - 1_000),
        last_error: null,
        created_at: iso(NOW - 30_000),
        sent_at: null,
        ...options.notification,
      },
      ...(options.extraNotifications ?? []),
    ],
    org_members:
      options.member === null
        ? []
        : [{ org_id: ORG, user_id: USER, role: 'owner', permissions: {}, ...options.member }],
    notification_preferences:
      options.events === null
        ? []
        : [
            {
              org_id: ORG,
              user_id: USER,
              events: options.events ?? [
                'conversation.new',
                'ticket.new',
                'handoff.pending',
                'assigned',
              ],
            },
          ],
    organizations: [{ id: ORG, name: 'Acme GmbH' }],
    channels: [
      { id: CHANNEL, org_id: ORG, name: 'Website-Chat' },
      { id: OTHER_CHANNEL, org_id: ORG, name: 'E-Mail Support' },
    ],
    contacts: [{ id: 'contact-1', org_id: ORG, name: 'Erika Mustermann' }],
    conversations: [
      {
        id: CONVERSATION,
        org_id: ORG,
        channel_id: CHANNEL,
        contact_id: 'contact-1',
        subject: 'Frage zur Rechnung',
      },
    ],
    tickets: [
      {
        id: TICKET,
        org_id: ORG,
        channel_id: CHANNEL,
        contact_id: 'contact-1',
        display_id: 'T-1042',
        subject: 'Rückfrage zur Lieferung',
      },
    ],
    messages: options.messages ?? [],
  });
}

function deps(
  db: MemoryDb,
  sent: SendEmailParams[],
  overrides: Partial<NotifyDeps> = {}
): NotifyDeps {
  return {
    supabase: db.client,
    logger,
    from: 'Zendori <no-reply@example.com>',
    appUrl: 'https://app.example.com/',
    getUserEmail: async () => 'member@example.com',
    send: async (params) => {
      sent.push(params);
    },
    now: () => NOW,
    ...overrides,
  };
}

const row = (db: MemoryDb) => db.rows('member_notifications')[0] as Record<string, unknown>;

const conversationEvent = {
  event_type: 'conversation.new',
  entity_type: 'conversation',
  entity_id: CONVERSATION,
};

describe('deliverMemberNotification', () => {
  it('sends the ticket mail once and marks the row sent', async () => {
    const db = seed();
    const sent: SendEmailParams[] = [];
    await deliverMemberNotification(deps(db, sent), 'n-1');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('member@example.com');
    expect(sent[0]?.from).toBe('Zendori <no-reply@example.com>');
    expect(sent[0]?.subject).toBe('Neues Ticket T-1042: Rückfrage zur Lieferung');
    expect(sent[0]?.html).toContain(`https://app.example.com/tickets/${TICKET}?org=${ORG}`);
    expect(sent[0]?.html).toContain('https://app.example.com/settings/notifications');
    expect(row(db)).toMatchObject({ state: 'sent', attempts: 1, last_error: null });
    expect(row(db).sent_at).toBe(iso(NOW));

    // a duplicate job is a no-op
    await deliverMemberNotification(deps(db, sent), 'n-1');
    expect(sent).toHaveLength(1);
  });

  it('does nothing before the row is due', async () => {
    const db = seed({ notification: { next_attempt_at: iso(NOW + 60_000) } });
    const sent: SendEmailParams[] = [];
    await deliverMemberNotification(deps(db, sent), 'n-1');
    expect(sent).toHaveLength(0);
    expect(row(db)).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('skips a user who left the organization', async () => {
    const db = seed({ member: null });
    const sent: SendEmailParams[] = [];
    await deliverMemberNotification(deps(db, sent), 'n-1');
    expect(sent).toHaveLength(0);
    expect(row(db)).toMatchObject({ state: 'skipped', last_error: 'not_a_member' });
  });

  it('skips when the member switched the event off in the meantime', async () => {
    for (const events of [['conversation.new'], null]) {
      const db = seed({ events });
      const sent: SendEmailParams[] = [];
      await deliverMemberNotification(deps(db, sent), 'n-1');
      expect(sent).toHaveLength(0);
      expect(row(db)).toMatchObject({ state: 'skipped', last_error: 'unsubscribed' });
    }
  });

  it('never tells a member about a record they may not see', async () => {
    // scoped to another channel
    const scoped = seed({
      member: {
        role: 'agent',
        permissions: { areas: { tickets: 'edit' }, channelIds: [OTHER_CHANNEL] },
      },
    });
    // no ticket area at all
    const noArea = seed({
      member: { role: 'agent', permissions: { areas: { inbox: 'edit' }, channelIds: null } },
    });
    for (const db of [scoped, noArea]) {
      const sent: SendEmailParams[] = [];
      await deliverMemberNotification(deps(db, sent), 'n-1');
      expect(sent).toHaveLength(0);
      expect(row(db)).toMatchObject({ state: 'skipped', last_error: 'no_access' });
    }

    // the same member with the right channel gets it
    const allowed = seed({
      member: { role: 'agent', permissions: { areas: { tickets: 'view' }, channelIds: [CHANNEL] } },
    });
    const sent: SendEmailParams[] = [];
    await deliverMemberNotification(deps(allowed, sent), 'n-1');
    expect(sent).toHaveLength(1);
  });

  it('skips a record that no longer exists', async () => {
    const db = seed({ notification: { entity_id: 'ticket-gone' } });
    const sent: SendEmailParams[] = [];
    await deliverMemberNotification(deps(db, sent), 'n-1');
    expect(sent).toHaveLength(0);
    expect(row(db)).toMatchObject({ state: 'skipped', last_error: 'record_gone' });
  });

  it('new conversation: waits for the AI pipeline, without counting an attempt', async () => {
    const db = seed({
      notification: conversationEvent,
      messages: [
        {
          id: 'm-1',
          conversation_id: CONVERSATION,
          direction: 'in',
          processing_state: 'pending',
          metadata: {},
          created_at: iso(NOW - 20_000),
        },
      ],
    });
    const sent: SendEmailParams[] = [];
    await deliverMemberNotification(deps(db, sent), 'n-1');
    expect(sent).toHaveLength(0);
    expect(row(db)).toMatchObject({
      state: 'pending',
      attempts: 0,
      next_attempt_at: iso(NOW + NEW_CONVERSATION_RECHECK_MS),
    });
  });

  it('new conversation: gives up waiting after the maximum and sends', async () => {
    const db = seed({
      notification: {
        ...conversationEvent,
        created_at: iso(NOW - NEW_CONVERSATION_MAX_WAIT_MS - 1_000),
      },
      messages: [
        {
          id: 'm-1',
          conversation_id: CONVERSATION,
          direction: 'in',
          processing_state: 'pending',
          metadata: {},
          created_at: iso(NOW - NEW_CONVERSATION_MAX_WAIT_MS - 1_000),
        },
      ],
    });
    const sent: SendEmailParams[] = [];
    await deliverMemberNotification(deps(db, sent), 'n-1');
    expect(sent).toHaveLength(1);
  });

  it('new conversation: spam and auto-replies notify nobody', async () => {
    for (const classification of [{ is_spam: true }, { is_auto_reply: true }]) {
      const db = seed({
        notification: conversationEvent,
        messages: [
          {
            id: 'm-1',
            conversation_id: CONVERSATION,
            direction: 'in',
            processing_state: 'skipped',
            metadata: { classification },
            created_at: iso(NOW - 20_000),
          },
        ],
      });
      const sent: SendEmailParams[] = [];
      await deliverMemberNotification(deps(db, sent), 'n-1');
      expect(sent).toHaveLength(0);
      expect(row(db)).toMatchObject({ state: 'skipped', last_error: 'spam' });
    }
  });

  it('new conversation: the mail names the record but carries no message text', async () => {
    const db = seed({
      notification: conversationEvent,
      messages: [
        {
          id: 'm-1',
          conversation_id: CONVERSATION,
          direction: 'in',
          processing_state: 'done',
          content: 'STRENG VERTRAULICHER NACHRICHTENTEXT',
          metadata: { classification: { is_spam: false } },
          created_at: iso(NOW - 20_000),
        },
      ],
    });
    const sent: SendEmailParams[] = [];
    await deliverMemberNotification(deps(db, sent), 'n-1');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe('Neue Konversation: Frage zur Rechnung');
    expect(sent[0]?.html).toContain(
      `https://app.example.com/inbox?org=${ORG}&amp;conversation=${CONVERSATION}`
    );
    expect(sent[0]?.text).toContain('Kontakt: Erika Mustermann');
    expect(sent[0]?.text).toContain('Kanal: Website-Chat');
    expect(`${sent[0]?.html}${sent[0]?.text}`).not.toContain('VERTRAULICH');
  });

  it('"new" plus "assigned to you" for the same record becomes one mail', async () => {
    const twin = {
      id: 'n-2',
      org_id: ORG,
      user_id: USER,
      event_type: 'assigned',
      entity_type: 'ticket',
      entity_id: TICKET,
      details: {},
      state: 'pending',
      attempts: 0,
      next_attempt_at: iso(NOW - 1_000),
      created_at: iso(NOW - 30_000),
    };
    const db = seed({ extraNotifications: [twin] });
    const sent: SendEmailParams[] = [];
    await deliverMemberNotification(deps(db, sent), 'n-1');
    await deliverMemberNotification(deps(db, sent), 'n-2');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe('Ihnen zugewiesen: Ticket T-1042 — Rückfrage zur Lieferung');
    expect(row(db)).toMatchObject({ state: 'skipped', last_error: 'covered_by_assignment' });
  });

  it('handoff: passes the reason into the mail', async () => {
    const db = seed({
      notification: {
        event_type: 'handoff.pending',
        entity_type: 'conversation',
        entity_id: CONVERSATION,
        details: { reason: 'low_confidence' },
      },
    });
    const sent: SendEmailParams[] = [];
    await deliverMemberNotification(deps(db, sent), 'n-1');
    expect(sent[0]?.subject).toBe('Wartet auf einen Mitarbeiter: Frage zur Rechnung');
    expect(sent[0]?.text).toContain('Grund: Der KI-Agent war sich bei der Antwort nicht sicher');
  });

  it('a failed send is retried on schedule and given up after the last attempt', async () => {
    const db = seed();
    const sent: SendEmailParams[] = [];
    const failing = deps(db, sent, {
      send: async () => {
        throw new Error('resend down');
      },
    });
    await deliverMemberNotification(failing, 'n-1');
    expect(row(db)).toMatchObject({
      state: 'pending',
      attempts: 1,
      last_error: 'send_failed',
      next_attempt_at: iso(NOW + 60_000),
    });

    // jump to the last allowed attempt
    Object.assign(row(db), {
      attempts: MEMBER_NOTIFICATION_MAX_ATTEMPTS - 1,
      next_attempt_at: iso(NOW - 1_000),
    });
    await deliverMemberNotification(failing, 'n-1');
    expect(row(db)).toMatchObject({
      state: 'failed',
      attempts: MEMBER_NOTIFICATION_MAX_ATTEMPTS,
      last_error: 'send_failed',
    });
  });

  it('fails for good without a configured sender, and skips an account without address', async () => {
    const noSender = seed();
    const sent: SendEmailParams[] = [];
    await deliverMemberNotification(deps(noSender, sent, { from: undefined }), 'n-1');
    expect(row(noSender)).toMatchObject({ state: 'failed', last_error: 'sender_not_configured' });

    const noAddress = seed();
    await deliverMemberNotification(
      deps(noAddress, sent, { getUserEmail: async () => null }),
      'n-1'
    );
    expect(row(noAddress)).toMatchObject({ state: 'skipped', last_error: 'no_address' });
    expect(sent).toHaveLength(0);
  });

  it('an unknown event type is dropped instead of retried forever', async () => {
    const db = seed({ notification: { event_type: 'ticket.deleted' } });
    const sent: SendEmailParams[] = [];
    await deliverMemberNotification(deps(db, sent), 'n-1');
    expect(row(db)).toMatchObject({ state: 'skipped', last_error: 'unknown_event' });
  });
});

describe('pruneMemberNotifications', () => {
  it('removes rows older than the retention window', async () => {
    const db = seed({
      extraNotifications: [
        {
          id: 'old',
          org_id: ORG,
          user_id: USER,
          state: 'sent',
          created_at: iso(NOW - MEMBER_NOTIFICATION_RETENTION_MS - 60_000),
        },
      ],
    });
    await pruneMemberNotifications(db.client, NOW);
    expect(db.rows('member_notifications').map((r) => r.id)).toEqual(['n-1']);
  });
});
