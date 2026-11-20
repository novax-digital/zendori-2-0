// E-mail notifications for team members (migration 0038). DB triggers queue one
// row per (event, subscribed member) in member_notifications; this module sends
// them. Runs in the worker (§12: Vercel does nothing long-running).
//
// Before a mail goes out the worker re-checks everything that may have changed
// since the trigger fired: still a member, still subscribed, may see the record
// (area + channel scope). A "new conversation" mail additionally waits for the
// AI pipeline, so spam never notifies anyone.
//
// The retry schedule lives in the row (next_attempt_at); a job never needs a
// pg-boss retry. Never logs addresses or content (§7).
import {
  MEMBER_NOTIFICATION_MAX_ATTEMPTS,
  NEW_CONVERSATION_MAX_WAIT_MS,
  NEW_CONVERSATION_RECHECK_MS,
  canReceiveNotification,
  isMissingRelationError,
  isNotificationEventType,
  memberNotificationRetryDelayMs,
  parseMemberPermissions,
  parseNotificationEvents,
  type Logger,
  type MemberAccess,
  type NotificationEntityType,
  type NotificationEventType,
  type OrgRole,
  type SupabaseClient,
} from '@zendori/core';
import {
  isSuppressedEmailRecipient,
  renderMemberNotificationEmail,
  sendEmail,
  type SendEmailParams,
} from '@zendori/channels';
import { toErrorInfo } from '../db.js';

export const MEMBER_NOTIFY_QUEUE = 'member.notify';
/** Retries are scheduled in the row — the job itself never retries. */
export const MEMBER_NOTIFY_RETRY_LIMIT = 0;
/** While a try runs, the row is invisible to the scan for this long. */
export const MEMBER_NOTIFY_LEASE_MS = 5 * 60_000;
/** Handled rows are kept this long as a delivery trace. */
export const MEMBER_NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60_000;

const DEFAULT_APP_URL = 'https://app.zendori.ai';

export interface MemberNotifyJob {
  notificationId: string;
}

export interface NotifyDeps {
  supabase: SupabaseClient;
  logger: Logger;
  /** Sender address (RESEND_FROM). */
  from: string | undefined;
  /** Public app URL for the links (APP_URL). */
  appUrl: string | undefined;
  /** Login e-mail of a member; null when the account is gone. Injectable for tests. */
  getUserEmail?: (userId: string) => Promise<string | null>;
  /** Injectable for tests. */
  send?: (params: SendEmailParams) => Promise<unknown>;
  now?: () => number;
}

interface NotificationRow {
  id: string;
  org_id: string;
  user_id: string;
  event_type: string;
  entity_type: NotificationEntityType;
  entity_id: string;
  details: unknown;
  attempts: number;
  created_at: string;
}

type Outcome =
  | { kind: 'sent' }
  /** Deliberately not sent (no access, spam, unsubscribed, …). Final. */
  | { kind: 'skipped'; reason: string }
  /** Not ready yet — try again later without counting an attempt. */
  | { kind: 'postpone'; delayMs: number }
  /** Temporary problem — counted, retried on schedule. */
  | { kind: 'retry'; error: string }
  /** Cannot work without a config change. Final. */
  | { kind: 'failed'; error: string };

interface EntityInfo {
  channelId: string | null;
  contactId: string | null;
  subject: string | null;
  ticketDisplayId: string | null;
}

async function defaultGetUserEmail(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error) {
    if (error.status === 404) return null;
    throw error;
  }
  return data.user?.email ?? null;
}

async function loadEntity(
  supabase: SupabaseClient,
  row: NotificationRow
): Promise<EntityInfo | null> {
  if (row.entity_type === 'ticket') {
    const { data, error } = await supabase
      .from('tickets')
      .select('id, channel_id, contact_id, display_id, subject')
      .eq('org_id', row.org_id)
      .eq('id', row.entity_id)
      .maybeSingle();
    if (error) throw error;
    const ticket = data as {
      channel_id: string | null;
      contact_id: string | null;
      display_id: string | null;
      subject: string | null;
    } | null;
    if (!ticket) return null;
    return {
      channelId: ticket.channel_id,
      contactId: ticket.contact_id,
      subject: ticket.subject,
      ticketDisplayId: ticket.display_id,
    };
  }
  const { data, error } = await supabase
    .from('conversations')
    .select('id, channel_id, contact_id, subject')
    .eq('org_id', row.org_id)
    .eq('id', row.entity_id)
    .maybeSingle();
  if (error) throw error;
  const conversation = data as {
    channel_id: string | null;
    contact_id: string | null;
    subject: string | null;
  } | null;
  if (!conversation) return null;
  return {
    channelId: conversation.channel_id,
    contactId: conversation.contact_id,
    subject: conversation.subject,
    ticketDisplayId: null,
  };
}

/**
 * Spam gate for "new conversation": looks at the first inbound message.
 * Returns what to do, or null when the mail may go out.
 */
async function newConversationGate(
  deps: NotifyDeps,
  row: NotificationRow,
  nowMs: number
): Promise<Outcome | null> {
  const { data, error } = await deps.supabase
    .from('messages')
    .select('id, processing_state, metadata')
    .eq('conversation_id', row.entity_id)
    .eq('direction', 'in')
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  const first = ((data ?? []) as { processing_state: string | null; metadata: unknown }[])[0];
  const waited = nowMs - new Date(row.created_at).getTime();
  const mayWait = waited < NEW_CONVERSATION_MAX_WAIT_MS;

  // no message yet, or the AI pipeline has not looked at it → come back later
  if (!first || first.processing_state === 'pending') {
    return mayWait ? { kind: 'postpone', delayMs: NEW_CONVERSATION_RECHECK_MS } : null;
  }
  const metadata =
    first.metadata !== null && typeof first.metadata === 'object'
      ? (first.metadata as { classification?: { is_spam?: unknown; is_auto_reply?: unknown } })
      : {};
  if (
    metadata.classification?.is_spam === true ||
    metadata.classification?.is_auto_reply === true
  ) {
    return { kind: 'skipped', reason: 'spam' };
  }
  return null;
}

async function attempt(deps: NotifyDeps, row: NotificationRow, nowMs: number): Promise<Outcome> {
  const { supabase } = deps;
  if (!isNotificationEventType(row.event_type)) return { kind: 'skipped', reason: 'unknown_event' };
  const event: NotificationEventType = row.event_type;

  // still a member?
  const { data: memberData, error: memberError } = await supabase
    .from('org_members')
    .select('role, permissions')
    .eq('org_id', row.org_id)
    .eq('user_id', row.user_id)
    .maybeSingle();
  if (memberError) throw memberError;
  const member = memberData as { role: OrgRole; permissions: unknown } | null;
  if (!member) return { kind: 'skipped', reason: 'not_a_member' };
  const access: MemberAccess = {
    role: member.role,
    permissions: parseMemberPermissions(member.permissions),
  };

  // still subscribed? (switched off between the event and now)
  const { data: prefData, error: prefError } = await supabase
    .from('notification_preferences')
    .select('events')
    .eq('org_id', row.org_id)
    .eq('user_id', row.user_id)
    .maybeSingle();
  if (prefError) throw prefError;
  const events = parseNotificationEvents((prefData as { events?: unknown } | null)?.events);
  if (!events.includes(event)) return { kind: 'skipped', reason: 'unsubscribed' };

  const entity = await loadEntity(supabase, row);
  if (!entity) return { kind: 'skipped', reason: 'record_gone' };
  if (!canReceiveNotification(access, row.entity_type, entity.channelId)) {
    return { kind: 'skipped', reason: 'no_access' };
  }

  // "new …" + "assigned to you" for the same record → one mail (the assignment)
  if (event === 'conversation.new' || event === 'ticket.new') {
    const { data: twin, error: twinError } = await supabase
      .from('member_notifications')
      .select('id')
      .eq('user_id', row.user_id)
      .eq('entity_id', row.entity_id)
      .eq('event_type', 'assigned')
      .limit(1);
    if (twinError) throw twinError;
    if ((twin ?? []).length > 0) return { kind: 'skipped', reason: 'covered_by_assignment' };
  }

  if (event === 'conversation.new') {
    const gate = await newConversationGate(deps, row, nowMs);
    if (gate) return gate;
  }

  if (!deps.from) return { kind: 'failed', error: 'sender_not_configured' };
  const email = deps.getUserEmail
    ? await deps.getUserEmail(row.user_id)
    : await defaultGetUserEmail(supabase, row.user_id);
  if (!email || !email.includes('@')) return { kind: 'skipped', reason: 'no_address' };
  // mail-loop guard: never send to an intake address
  if (isSuppressedEmailRecipient(email)) return { kind: 'skipped', reason: 'suppressed_address' };

  const [orgRes, channelRes, contactRes] = await Promise.all([
    supabase.from('organizations').select('name').eq('id', row.org_id).maybeSingle(),
    entity.channelId
      ? supabase
          .from('channels')
          .select('name')
          .eq('org_id', row.org_id)
          .eq('id', entity.channelId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    entity.contactId
      ? supabase
          .from('contacts')
          .select('name')
          .eq('org_id', row.org_id)
          .eq('id', entity.contactId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const orgName = (orgRes.data as { name?: string } | null)?.name ?? 'Zendori';
  const channelName = (channelRes.data as { name?: string } | null)?.name ?? null;
  const contactName = (contactRes.data as { name?: string | null } | null)?.name ?? null;

  const appUrl = (deps.appUrl ?? DEFAULT_APP_URL).replace(/\/+$/, '');
  const org = encodeURIComponent(row.org_id);
  const openUrl =
    row.entity_type === 'ticket'
      ? `${appUrl}/tickets/${row.entity_id}?org=${org}`
      : `${appUrl}/inbox?org=${org}&conversation=${row.entity_id}`;
  const details =
    row.details !== null && typeof row.details === 'object'
      ? (row.details as { reason?: unknown })
      : {};

  const rendered = renderMemberNotificationEmail({
    event,
    orgName,
    entityType: row.entity_type,
    subject: entity.subject,
    ticketDisplayId: entity.ticketDisplayId,
    channelName,
    contactName,
    handoffReason: typeof details.reason === 'string' ? details.reason : null,
    occurredAt: new Date(row.created_at),
    openUrl,
    settingsUrl: `${appUrl}/settings/notifications?org=${org}`,
    appUrl,
  });

  try {
    await (deps.send ?? sendEmail)({
      from: deps.from,
      to: email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
  } catch (err) {
    deps.logger.warn(
      { notificationId: row.id, err: toErrorInfo(err) },
      'member notification send failed'
    );
    return { kind: 'retry', error: 'send_failed' };
  }
  return { kind: 'sent' };
}

/**
 * One delivery attempt for one queue row. Idempotent per attempt: only a
 * pending row whose time has come can be leased, so a duplicate job is a no-op.
 */
export async function deliverMemberNotification(
  deps: NotifyDeps,
  notificationId: string
): Promise<void> {
  const nowMs = (deps.now ?? Date.now)();
  const { data: leased, error: leaseError } = await deps.supabase
    .from('member_notifications')
    .update({ next_attempt_at: new Date(nowMs + MEMBER_NOTIFY_LEASE_MS).toISOString() })
    .eq('id', notificationId)
    .eq('state', 'pending')
    .lte('next_attempt_at', new Date(nowMs).toISOString())
    .select(
      'id, org_id, user_id, event_type, entity_type, entity_id, details, attempts, created_at'
    );
  if (leaseError) throw leaseError;
  const row = ((leased ?? []) as NotificationRow[])[0];
  if (!row) return; // not due, already handled, or gone

  let outcome: Outcome;
  try {
    outcome = await attempt(deps, row, nowMs);
  } catch (err) {
    // Unexpected (database / auth) problem: count the attempt and retry on schedule.
    deps.logger.error(
      { notificationId, err: toErrorInfo(err) },
      'member notification attempt failed'
    );
    outcome = { kind: 'retry', error: 'internal' };
  }

  const attempts = row.attempts + 1;
  let patch: Record<string, unknown>;
  let logged: string;
  if (outcome.kind === 'sent') {
    patch = { state: 'sent', attempts, last_error: null, sent_at: new Date(nowMs).toISOString() };
    logged = 'sent';
  } else if (outcome.kind === 'skipped') {
    patch = { state: 'skipped', last_error: outcome.reason };
    logged = `skipped:${outcome.reason}`;
  } else if (outcome.kind === 'postpone') {
    patch = { next_attempt_at: new Date(nowMs + outcome.delayMs).toISOString() };
    logged = 'postponed';
  } else if (outcome.kind === 'failed') {
    patch = { state: 'failed', attempts, last_error: outcome.error };
    logged = `failed:${outcome.error}`;
  } else {
    const delay = memberNotificationRetryDelayMs(attempts);
    if (delay === null || attempts >= MEMBER_NOTIFICATION_MAX_ATTEMPTS) {
      patch = { state: 'failed', attempts, last_error: outcome.error };
      logged = `failed:${outcome.error}`;
    } else {
      patch = {
        attempts,
        last_error: outcome.error,
        next_attempt_at: new Date(nowMs + delay).toISOString(),
      };
      logged = `retry:${outcome.error}`;
    }
  }

  const { error: updateError } = await deps.supabase
    .from('member_notifications')
    .update(patch)
    .eq('id', row.id);
  if (updateError) throw updateError;

  if (outcome.kind !== 'postpone') {
    deps.logger.info(
      { notificationId, eventType: row.event_type, outcome: logged, attempts },
      'member notification'
    );
  }
}

/** Forget handled queue rows after the retention window (and stuck ones with them). */
export async function pruneMemberNotifications(
  supabase: SupabaseClient,
  nowMs: number = Date.now()
): Promise<void> {
  const cutoff = new Date(nowMs - MEMBER_NOTIFICATION_RETENTION_MS).toISOString();
  const { error } = await supabase.from('member_notifications').delete().lt('created_at', cutoff);
  if (error && !isMissingRelationError(error)) throw error;
}
