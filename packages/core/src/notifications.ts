import { z } from 'zod';
import { canAccessChannel, canViewArea, type AreaKey, type MemberAccess } from './permissions.js';

// E-mail notifications for team members (migration 0038). Every member decides
// per organization which events they want an e-mail for
// (notification_preferences.events). DB triggers queue one row per subscribed
// member in member_notifications; the worker checks access, renders the
// template and sends. Nothing is sent without an explicit opt-in.

export const NOTIFICATION_EVENTS = [
  'conversation.new',
  'ticket.new',
  'handoff.pending',
  'assigned',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENTS)[number];

export type NotificationEntityType = 'conversation' | 'ticket';

export interface NotificationEventDef {
  key: NotificationEventType;
  /** UI label (settings page) */
  label: string;
  /** One sentence: when the e-mail is sent. */
  description: string;
  /** Areas of which the member needs at least one to receive this event. */
  areas: AreaKey[];
}

export const NOTIFICATION_EVENT_DEFS: NotificationEventDef[] = [
  {
    key: 'conversation.new',
    label: 'Neue Konversation',
    description: 'Eine neue Konversation ist in einem deiner Kanäle eingegangen (ohne Spam).',
    areas: ['inbox'],
  },
  {
    key: 'ticket.new',
    label: 'Neues Ticket',
    description: 'Ein Ticket wurde angelegt — vom KI-Agenten, aus einem Formular oder von Hand.',
    areas: ['tickets'],
  },
  {
    key: 'handoff.pending',
    label: 'Übergabe an einen Menschen',
    description: 'Der KI-Agent hat eine Konversation übergeben, sie wartet auf eine Antwort.',
    areas: ['inbox'],
  },
  {
    key: 'assigned',
    label: 'Mir zugewiesen',
    description: 'Eine Konversation oder ein Ticket wurde dir zugewiesen.',
    areas: ['inbox', 'tickets'],
  },
];

export function isNotificationEventType(value: unknown): value is NotificationEventType {
  return typeof value === 'string' && (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

/** Tolerant text[] → known event keys, de-duplicated, in the canonical order. */
export function parseNotificationEvents(raw: unknown): NotificationEventType[] {
  if (!Array.isArray(raw)) return [];
  const chosen = new Set(raw.filter(isNotificationEventType));
  return NOTIFICATION_EVENTS.filter((event) => chosen.has(event));
}

/** Strict variant for the settings form. */
export const notificationEventsSchema = z
  .array(z.enum(NOTIFICATION_EVENTS))
  .max(NOTIFICATION_EVENTS.length)
  .transform((events) => parseNotificationEvents(events));

/** The area that governs access to an entity of this kind. */
export function notificationEntityArea(entityType: NotificationEntityType): AreaKey {
  return entityType === 'ticket' ? 'tickets' : 'inbox';
}

/** May this member switch the event on at all (has one of its areas)? */
export function canSubscribeNotification(
  access: MemberAccess,
  event: NotificationEventType
): boolean {
  const def = NOTIFICATION_EVENT_DEFS.find((d) => d.key === event);
  return def ? def.areas.some((area) => canViewArea(access, area)) : false;
}

/**
 * May this member be told about this record? Same rules as the app: the area
 * of the record, and for channel-scoped members the record's channel. A record
 * without a channel is only visible to unscoped members.
 */
export function canReceiveNotification(
  access: MemberAccess,
  entityType: NotificationEntityType,
  channelId: string | null
): boolean {
  if (!canViewArea(access, notificationEntityArea(entityType))) return false;
  if (channelId === null) return canAccessChannelless(access);
  return canAccessChannel(access, channelId);
}

function canAccessChannelless(access: MemberAccess): boolean {
  return access.role !== 'agent' || access.permissions.channelIds === null;
}

// --- delivery schedule (worker) ---------------------------------------------------

/** Wait after a failed send before the next try; the row is given up afterwards. */
export const MEMBER_NOTIFICATION_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
export const MEMBER_NOTIFICATION_MAX_ATTEMPTS = MEMBER_NOTIFICATION_RETRY_DELAYS_MS.length + 1;

/** Delay before attempt `attempts + 1`, or null when the row is exhausted. */
export function memberNotificationRetryDelayMs(attempts: number): number | null {
  if (attempts < 1 || attempts >= MEMBER_NOTIFICATION_MAX_ATTEMPTS) return null;
  return MEMBER_NOTIFICATION_RETRY_DELAYS_MS[attempts - 1] ?? null;
}

/**
 * A "new conversation" mail waits until the first message went through the AI
 * pipeline (spam must not notify anyone) — but never longer than this.
 */
export const NEW_CONVERSATION_MAX_WAIT_MS = 10 * 60_000;
/** Re-check interval while the first message is still being processed. */
export const NEW_CONVERSATION_RECHECK_MS = 15_000;
