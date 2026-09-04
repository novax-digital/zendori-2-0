import 'server-only';
import {
  isMissingColumnError,
  isMissingRelationError,
  type Contact,
  type Message,
  type Ticket,
  type TicketEvent,
} from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { attachMessageAttachments, resolveUserEmails } from '@/lib/inbox/queries';
import type { NoteItem } from '@/lib/inbox/types';
import type {
  TicketDetail,
  TicketFilters,
  TicketListItem,
  TicketSettings,
  TicketStatusFilter,
  TicketSummary,
} from './types';

// Read side of the Tickets area (Phase 11). Every query tolerates migration
// 0030 not being applied yet (missing relation/column ⇒ empty / null) so the
// web deploy can precede the db push.

const ACTIVE_STATUSES = ['open', 'in_progress', 'waiting'];
const LIST_SELECT =
  '*, channel:channels(id, name, type), contact:contacts(id, name, email, company)';

function statusesFor(filter: TicketStatusFilter): string[] | null {
  if (filter === 'all') return null;
  if (filter === 'active') return ACTIVE_STATUSES;
  return [filter];
}

/** ILIKE needle for the PostgREST fallback: escape \ % _, drop * (PostgREST treats it as %). */
function likePattern(term: string): string {
  const escaped = term
    .replace(/\*/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    // commas/parentheses would break the .or() filter grammar
    .replace(/[(),]/g, ' ');
  return `%${escaped}%`;
}

export async function listTickets(
  orgId: string,
  filters: TicketFilters,
  userId: string | null,
  allowedChannelIds: string[] | null = null
): Promise<TicketListItem[]> {
  if (allowedChannelIds && allowedChannelIds.length === 0) return [];
  const supabase = await createSupabaseServerClient();
  const statuses = statusesFor(filters.status);

  // Search (0030 RPC, 0028 pattern); PGRST202/42883 = function missing ⇒ ILIKE fallback.
  let searchIds: string[] | null = null;
  let fallbackLike = false;
  const q = filters.q.trim();
  if (q.length > 0) {
    const { data, error } = await supabase.rpc('search_tickets', {
      p_org_id: orgId,
      p_query: q,
      p_statuses: statuses,
      p_channel_ids: allowedChannelIds,
      p_limit: 100,
    });
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PGRST202' || code === '42883') fallbackLike = true;
      else if (isMissingRelationError(error)) return [];
      else {
        console.error('search_tickets failed', { code });
        fallbackLike = true;
      }
    } else {
      searchIds = ((data ?? []) as { id: string }[]).map((r) => r.id);
      if (searchIds.length === 0) return [];
    }
  }

  let query = supabase.from('tickets').select(LIST_SELECT).eq('org_id', orgId);
  if (statuses) query = query.in('status', statuses);
  if (allowedChannelIds) query = query.in('channel_id', allowedChannelIds);
  if (filters.channelId !== 'all') query = query.eq('channel_id', filters.channelId);
  if (filters.priority !== 'all') query = query.eq('priority', filters.priority);
  if (filters.assignee === 'me' && userId) query = query.eq('assignee_id', userId);
  if (filters.assignee === 'none') query = query.is('assignee_id', null);
  if (searchIds) query = query.in('id', searchIds);
  if (fallbackLike) {
    const pat = likePattern(q);
    query = query.or(`display_id.ilike.${pat},subject.ilike.${pat}`);
  }
  const { data, error } = await query.order('updated_at', { ascending: false }).limit(100);
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }
  return (data ?? []) as TicketListItem[];
}

export async function getTicketDetail(
  orgId: string,
  ticketId: string,
  allowedChannelIds: string[] | null = null
): Promise<TicketDetail | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('tickets')
    .select('*, channel:channels(id, name, type), contact:contacts(*)')
    .eq('org_id', orgId)
    .eq('id', ticketId)
    .maybeSingle();
  if (error) {
    if (isMissingRelationError(error)) return null;
    throw error;
  }
  if (!data) return null;
  const row = data as Ticket & {
    channel: TicketDetail['channel'];
    contact: Contact | null;
  };
  if (allowedChannelIds && !allowedChannelIds.includes(row.channel_id)) return null;
  const { channel, contact, ...ticket } = row;

  const [convRes, messagesRes, earlierRes, notesRes, eventsRes] = await Promise.all([
    supabase
      .from('conversations')
      .select('id, subject, status, mode')
      .eq('org_id', orgId)
      .eq('id', ticket.conversation_id)
      .maybeSingle(),
    supabase
      .from('messages')
      .select('*')
      .eq('org_id', orgId)
      .eq('conversation_id', ticket.conversation_id)
      .gte('created_at', ticket.opened_at)
      .order('created_at', { ascending: true }),
    supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('conversation_id', ticket.conversation_id)
      .lt('created_at', ticket.opened_at),
    supabase
      .from('notes')
      .select('*')
      .eq('org_id', orgId)
      .eq('conversation_id', ticket.conversation_id)
      .order('created_at', { ascending: true }),
    supabase
      .from('ticket_events')
      .select('*')
      .eq('org_id', orgId)
      .eq('ticket_id', ticket.id)
      .order('created_at', { ascending: true }),
  ]);

  const messages = await attachMessageAttachments(orgId, (messagesRes.data ?? []) as Message[]);
  const rawNotes = (notesRes.data ?? []) as {
    id: string;
    content: string;
    author_id: string | null;
    created_at: string;
  }[];
  const emails = await resolveUserEmails(
    rawNotes.map((n) => n.author_id).filter((id): id is string => id !== null)
  );
  const notes: NoteItem[] = rawNotes.map((n) => ({
    ...n,
    author_email: n.author_id ? (emails.get(n.author_id) ?? null) : null,
  }));

  return {
    ticket,
    channel: channel ?? null,
    contact: contact ?? null,
    conversation: (convRes.data as TicketDetail['conversation']) ?? null,
    messages,
    earlierMessageCount: earlierRes.count ?? 0,
    notes,
    events: eventsRes.error ? [] : ((eventsRes.data ?? []) as TicketEvent[]),
  };
}

/** Chips for the inbox: newest first; [] while 0030 is pending. */
export async function listTicketsForConversation(
  orgId: string,
  conversationId: string
): Promise<TicketSummary[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('tickets')
    .select('id, display_id, status, subject, origin, created_at')
    .eq('org_id', orgId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false });
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }
  return (data ?? []) as TicketSummary[];
}

/** Numbering settings for Einstellungen → Tickets; null while 0030 is pending. */
export async function getTicketSettings(orgId: string): Promise<TicketSettings | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('org_settings')
    .select('ticket_id_format, ticket_number_start')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) {
    if (isMissingColumnError(error) || isMissingRelationError(error)) return null;
    throw error;
  }
  const row = (data ?? {}) as { ticket_id_format?: string; ticket_number_start?: number };
  const format = typeof row.ticket_id_format === 'string' ? row.ticket_id_format : '#{N}';
  const start = typeof row.ticket_number_start === 'number' ? row.ticket_number_start : 1;
  const { data: counter } = await supabase
    .from('ticket_counters')
    .select('last_number')
    .eq('org_id', orgId)
    .maybeSingle();
  const last = (counter as { last_number?: number | string } | null)?.last_number;
  const counterStarted = last !== undefined && last !== null;
  return {
    format,
    start,
    counterStarted,
    nextNumber: counterStarted ? Number(last) + 1 : start,
  };
}
