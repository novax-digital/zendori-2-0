import { describe, expect, it } from 'vitest';
import {
  MEMBER_NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_DEFS,
  canReceiveNotification,
  canSubscribeNotification,
  memberNotificationRetryDelayMs,
  notificationEventsSchema,
  parseNotificationEvents,
  type MemberAccess,
} from '../src/index.js';

// Member notifications (0038): which events exist, who may switch them on, and
// who may be told about a record. The access rules must match the app's own
// (area + channel scope) — a notification must never reveal what the inbox hides.

const CHANNEL_A = '11111111-1111-4111-8111-111111111111';
const CHANNEL_B = '22222222-2222-4222-8222-222222222222';

const owner: MemberAccess = { role: 'owner', permissions: { areas: {}, channelIds: null } };
const admin: MemberAccess = { role: 'admin', permissions: { areas: {}, channelIds: null } };
const inboxOnly: MemberAccess = {
  role: 'agent',
  permissions: { areas: { inbox: 'edit' }, channelIds: null },
};
const ticketsOnly: MemberAccess = {
  role: 'agent',
  permissions: { areas: { tickets: 'view' }, channelIds: null },
};
const scoped: MemberAccess = {
  role: 'agent',
  permissions: { areas: { inbox: 'edit', tickets: 'edit' }, channelIds: [CHANNEL_A] },
};
const nothing: MemberAccess = { role: 'agent', permissions: { areas: {}, channelIds: null } };

describe('notification events', () => {
  it('every event has a definition with a label and at least one area', () => {
    expect(NOTIFICATION_EVENT_DEFS.map((d) => d.key)).toEqual([...NOTIFICATION_EVENTS]);
    for (const def of NOTIFICATION_EVENT_DEFS) {
      expect(def.label.length).toBeGreaterThan(3);
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.areas.length).toBeGreaterThan(0);
    }
  });

  it('parses stored values tolerantly: unknown keys dropped, duplicates removed, canonical order', () => {
    expect(
      parseNotificationEvents(['ticket.new', 'nope', 'conversation.new', 'ticket.new'])
    ).toEqual(['conversation.new', 'ticket.new']);
    expect(parseNotificationEvents(null)).toEqual([]);
    expect(parseNotificationEvents('ticket.new')).toEqual([]);
    expect(parseNotificationEvents([1, {}, 'assigned'])).toEqual(['assigned']);
  });

  it('the strict schema rejects unknown events', () => {
    expect(notificationEventsSchema.safeParse(['ticket.new', 'assigned']).success).toBe(true);
    expect(notificationEventsSchema.safeParse(['ticket.deleted']).success).toBe(false);
  });
});

describe('canSubscribeNotification', () => {
  it('owner and admin may switch on everything', () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(canSubscribeNotification(owner, event)).toBe(true);
      expect(canSubscribeNotification(admin, event)).toBe(true);
    }
  });

  it('a member only gets events of areas they can see', () => {
    expect(canSubscribeNotification(inboxOnly, 'conversation.new')).toBe(true);
    expect(canSubscribeNotification(inboxOnly, 'handoff.pending')).toBe(true);
    expect(canSubscribeNotification(inboxOnly, 'ticket.new')).toBe(false);
    expect(canSubscribeNotification(ticketsOnly, 'ticket.new')).toBe(true);
    expect(canSubscribeNotification(ticketsOnly, 'conversation.new')).toBe(false);
    // "assigned" covers conversations and tickets — one of the two areas is enough
    expect(canSubscribeNotification(inboxOnly, 'assigned')).toBe(true);
    expect(canSubscribeNotification(ticketsOnly, 'assigned')).toBe(true);
    expect(canSubscribeNotification(nothing, 'assigned')).toBe(false);
  });
});

describe('canReceiveNotification', () => {
  it('needs the area of the record', () => {
    expect(canReceiveNotification(inboxOnly, 'conversation', CHANNEL_A)).toBe(true);
    expect(canReceiveNotification(inboxOnly, 'ticket', CHANNEL_A)).toBe(false);
    expect(canReceiveNotification(ticketsOnly, 'ticket', CHANNEL_A)).toBe(true);
    expect(canReceiveNotification(ticketsOnly, 'conversation', CHANNEL_A)).toBe(false);
  });

  it('respects the channel scope of a member', () => {
    expect(canReceiveNotification(scoped, 'conversation', CHANNEL_A)).toBe(true);
    expect(canReceiveNotification(scoped, 'conversation', CHANNEL_B)).toBe(false);
    expect(canReceiveNotification(scoped, 'ticket', CHANNEL_B)).toBe(false);
    // a record without a channel is hidden from scoped members
    expect(canReceiveNotification(scoped, 'ticket', null)).toBe(false);
    expect(canReceiveNotification(inboxOnly, 'conversation', null)).toBe(true);
  });

  it('owner and admin are never scoped', () => {
    expect(canReceiveNotification(owner, 'ticket', CHANNEL_B)).toBe(true);
    expect(canReceiveNotification(admin, 'conversation', null)).toBe(true);
  });
});

describe('retry schedule', () => {
  it('grows and ends after the last attempt', () => {
    const delays = Array.from({ length: MEMBER_NOTIFICATION_MAX_ATTEMPTS + 1 }, (_, i) =>
      memberNotificationRetryDelayMs(i)
    );
    expect(delays[0]).toBeNull(); // nothing tried yet
    expect(delays[1]).toBe(60_000);
    expect(delays[2]).toBeGreaterThan(delays[1] as number);
    expect(delays[MEMBER_NOTIFICATION_MAX_ATTEMPTS]).toBeNull(); // exhausted
  });
});
