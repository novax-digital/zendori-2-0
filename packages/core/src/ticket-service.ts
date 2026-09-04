import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError, isMissingRelationError } from './db.js';
import { requestTicketHubspotSync } from './hubspot-rules.js';
import type { ConversationPriority } from './schemas.js';
import { PRIORITY_RANK, isPlaceholderSubject, type TicketOrigin, type TicketStatus } from './tickets.js';

// The ONE way tickets come into existence (Phase 11, docs/phase-11-tickets.md).
// Works with the worker's service-role client and with a user-scoped client
// under RLS (the inbox button, takeover). Attach rule v2 (Phase 12, owner
// 2026-09-04 — "a conversation always continues"): a qualifying event attaches
// to the NEWEST non-resolved ticket of the conversation only when the message
// is not a topic change and that ticket is younger than the attach window;
// otherwise it opens a new ticket even while older ones are still open.
// Number and display id are assigned by the 0030 insert trigger.

export interface EnsureTicketInput {
  orgId: string;
  conversationId: string;
  origin: TicketOrigin;
  subject?: string | null;
  description?: string | null;
  category?: string | null;
  priority?: ConversationPriority | null;
  assigneeId?: string | null;
  /** First message that belongs to the ticket (transcript starts there). */
  openedMessageId?: string | null;
  /** auth user for manual creation; null/absent = system/bot. */
  createdBy?: string | null;
  /** Content-free extras for ticket_events.details (reasons, ids). */
  details?: Record<string, unknown>;
  /**
   * On attach: 'gapfill' (default) only fills empty/placeholder subject and
   * description; 'overwrite' replaces them (a voice caller correcting the intake
   * within the same call).
   */
  attachMode?: 'gapfill' | 'overwrite';
  /**
   * Attach policy (Phase 12): 'auto' (default) attaches to the newest
   * non-resolved ticket unless newTopic or that ticket is older than
   * attachWindowHours; 'always' attaches to the newest open one regardless
   * (voice within a call, takeover, HubSpot button); 'never' always opens a
   * new ticket (forms, the manual inbox button).
   */
  attach?: 'auto' | 'always' | 'never';
  /** classification.is_new_topic — a topic change opens a new ticket. */
  newTopic?: boolean;
  /** Hours a ticket stays attachable after opened_at; null = unlimited. Default 24. */
  attachWindowHours?: number | null;
}

export const DEFAULT_ATTACH_WINDOW_HOURS = 24;

export interface TicketRef {
  id: string;
  number: number;
  displayId: string;
  status: TicketStatus;
  subject: string | null;
}

export type EnsureTicketResult =
  | { outcome: 'created' | 'attached'; ticket: TicketRef }
  | { outcome: 'unavailable'; reason: 'schema_skew' };

interface OpenTicketRow {
  id: string;
  number: number | string;
  display_id: string;
  status: TicketStatus;
  subject: string | null;
  description: string | null;
  category: string | null;
  priority: ConversationPriority;
  assignee_id: string | null;
  contact_id: string | null;
  channel_id: string;
  hubspot_ticket_id: string | null;
  opened_at: string;
  opened_message_id: string | null;
}

const OPEN_TICKET_SELECT =
  'id, number, display_id, status, subject, description, category, priority, assignee_id, contact_id, channel_id, hubspot_ticket_id, opened_at, opened_message_id';

/**
 * Attach rule v2, pure: does this event belong to the given open ticket?
 * - same opening message ⇒ yes (a pg-boss retry must never open a second ticket
 *   even if Haiku re-classifies the topic differently)
 * - topic change ⇒ no
 * - no window ⇒ yes; else only while the ticket is younger than the window
 */
export function shouldAttachToTicket(
  open: { opened_at: string; opened_message_id: string | null },
  input: { openedMessageId?: string | null; newTopic?: boolean; attachWindowHours?: number | null },
  now: Date = new Date()
): boolean {
  if (input.openedMessageId && open.opened_message_id === input.openedMessageId) return true;
  if (input.newTopic === true) return false;
  const window = input.attachWindowHours === undefined ? DEFAULT_ATTACH_WINDOW_HOURS : input.attachWindowHours;
  if (window === null) return true;
  const openedMs = Date.parse(open.opened_at);
  if (Number.isNaN(openedMs)) return true;
  return now.getTime() - openedMs <= window * 60 * 60 * 1000;
}

function toRef(row: {
  id: string;
  number: number | string;
  display_id: string;
  status: TicketStatus;
  subject: string | null;
}): TicketRef {
  return {
    id: row.id,
    number: Number(row.number),
    displayId: row.display_id,
    status: row.status,
    subject: row.subject,
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The conversation's NEWEST non-resolved ticket, null when there is none, or
 * 'unavailable' while migration 0030 is not applied yet. Several open tickets
 * per conversation are normal since attach rule v2 — the newest is "current".
 */
export async function findOpenTicket(
  supabase: SupabaseClient,
  orgId: string,
  conversationId: string
): Promise<OpenTicketRow | null | 'unavailable'> {
  const { data, error } = await supabase
    .from('tickets')
    .select(OPEN_TICKET_SELECT)
    .eq('org_id', orgId)
    .eq('conversation_id', conversationId)
    .neq('status', 'resolved')
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingRelationError(error) || isMissingColumnError(error)) return 'unavailable';
    throw error;
  }
  return (data as OpenTicketRow | null) ?? null;
}

async function attachToTicket(
  supabase: SupabaseClient,
  open: OpenTicketRow,
  input: EnsureTicketInput
): Promise<EnsureTicketResult> {
  const overwrite = input.attachMode === 'overwrite';
  const patch: Record<string, unknown> = {};
  const subject = nonEmpty(input.subject);
  if (subject && (overwrite || isPlaceholderSubject(open.subject))) patch.subject = subject;
  const description = nonEmpty(input.description);
  if (description && (overwrite || !open.description)) patch.description = description;
  const category = nonEmpty(input.category);
  if (category && !open.category) patch.category = category;
  if (input.priority && PRIORITY_RANK[input.priority] > PRIORITY_RANK[open.priority]) {
    patch.priority = input.priority;
  }
  if (input.assigneeId && !open.assignee_id) {
    patch.assignee_id = input.assigneeId;
    if (open.status === 'open') patch.status = 'in_progress';
  }
  // The conversation's contact is the live truth (Phase-4 correction may have
  // re-pointed it after the ticket was created) — refresh the snapshot.
  const { data: conv } = await supabase
    .from('conversations')
    .select('contact_id')
    .eq('org_id', input.orgId)
    .eq('id', input.conversationId)
    .maybeSingle();
  const liveContact = (conv as { contact_id: string | null } | null)?.contact_id ?? null;
  if (liveContact && liveContact !== open.contact_id) patch.contact_id = liveContact;
  // always touch — "this ticket is active again" is what the list sorts by
  patch.updated_at = new Date().toISOString();

  const { error: updateError } = await supabase
    .from('tickets')
    .update(patch)
    .eq('org_id', input.orgId)
    .eq('id', open.id);
  if (updateError) throw updateError;

  const { error: eventError } = await supabase.from('ticket_events').insert({
    org_id: input.orgId,
    ticket_id: open.id,
    kind: 'attached',
    actor_id: input.createdBy ?? null,
    details: {
      origin: input.origin,
      // content-free tuning signal for the attach rule (docs/phase-12-escalation.md)
      new_topic: input.newTopic === true,
      ...(input.openedMessageId ? { message_id: input.openedMessageId } : {}),
      ...(input.details ?? {}),
    },
  });
  if (eventError && !isMissingRelationError(eventError)) throw eventError;

  // Phase 11b: a new event on the ticket → HubSpot follow-up (rules of the ticket stream)
  await requestTicketHubspotSync(supabase, {
    orgId: input.orgId,
    channelId: open.channel_id,
    ticketId: open.id,
    alreadySynced: open.hubspot_ticket_id !== null,
  });

  const status = (patch.status as TicketStatus | undefined) ?? open.status;
  const subjectNow = (patch.subject as string | undefined) ?? open.subject;
  return { outcome: 'attached', ticket: toRef({ ...open, status, subject: subjectNow }) };
}

/** Create a ticket for the conversation or attach to its newest open one (attach rule v2). */
export async function ensureTicket(
  supabase: SupabaseClient,
  input: EnsureTicketInput
): Promise<EnsureTicketResult> {
  const open = await findOpenTicket(supabase, input.orgId, input.conversationId);
  if (open === 'unavailable') return { outcome: 'unavailable', reason: 'schema_skew' };
  const policy = input.attach ?? 'auto';
  if (open && policy !== 'never' && (policy === 'always' || shouldAttachToTicket(open, input))) {
    return attachToTicket(supabase, open, input);
  }

  const { data, error } = await supabase
    .from('tickets')
    .insert({
      org_id: input.orgId,
      conversation_id: input.conversationId,
      origin: input.origin,
      subject: nonEmpty(input.subject),
      description: nonEmpty(input.description),
      category: nonEmpty(input.category),
      priority: input.priority ?? 'normal',
      assignee_id: input.assigneeId ?? null,
      status: input.assigneeId ? 'in_progress' : 'open',
      opened_message_id: input.openedMessageId ?? null,
      created_by: input.createdBy ?? null,
    })
    .select('id, number, display_id, status, subject, channel_id')
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      // Only reachable while the 0030 partial index still exists (worker ahead
      // of 0031) or on a number/display-id collision: attach to the newest open
      // ticket instead of failing — today's behavior.
      const raced = await findOpenTicket(supabase, input.orgId, input.conversationId);
      if (raced && raced !== 'unavailable') return attachToTicket(supabase, raced, input);
    }
    if (isMissingRelationError(error) || isMissingColumnError(error)) {
      return { outcome: 'unavailable', reason: 'schema_skew' };
    }
    throw error;
  }
  const created = data as {
    id: string;
    number: number | string;
    display_id: string;
    status: TicketStatus;
    subject: string | null;
    channel_id: string;
  };
  // Phase 11b: arm the ticket-stream HubSpot sync (rules all | channels)
  await requestTicketHubspotSync(supabase, {
    orgId: input.orgId,
    channelId: created.channel_id,
    ticketId: created.id,
  });
  return { outcome: 'created', ticket: toRef(created) };
}

export interface RefineOpenTicketInput {
  orgId: string;
  conversationId: string;
  /** Always applied when given (a refinement of the same request). */
  priority?: ConversationPriority | null;
  subject?: string | null;
  /** 'gapfill' replaces only placeholder subjects; 'overwrite' always. */
  mode?: 'gapfill' | 'overwrite';
}

/**
 * Post-hoc refinement of the open ticket (voice post-call classify/extract):
 * no ticket is created here — a call without an intake has none and gets none.
 */
export async function refineOpenTicket(
  supabase: SupabaseClient,
  input: RefineOpenTicketInput
): Promise<void> {
  const open = await findOpenTicket(supabase, input.orgId, input.conversationId);
  if (!open || open === 'unavailable') return;
  const patch: Record<string, unknown> = {};
  if (input.priority && input.priority !== open.priority) patch.priority = input.priority;
  const subject = nonEmpty(input.subject);
  if (subject && (input.mode === 'overwrite' || isPlaceholderSubject(open.subject))) {
    patch.subject = subject.slice(0, 200);
  }
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase
    .from('tickets')
    .update(patch)
    .eq('org_id', input.orgId)
    .eq('id', open.id);
  if (error) throw error;
}
