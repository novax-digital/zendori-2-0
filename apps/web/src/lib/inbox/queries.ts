import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import type { Channel, Contact, Conversation, Message, OrgRole } from '@zendori/core';
import type {
  CannedResponseItem,
  ConversationDetail,
  ConversationListItem,
  InboxFilters,
  MemberOption,
  NoteItem,
} from './types';

const PREVIEW_MAX_LENGTH = 120;

/**
 * Collapses whitespace and truncates content for the conversation list preview.
 * Pure function — kept side-effect free so it stays unit-testable.
 */
export function truncatePreview(
  content: string | null | undefined,
  max: number = PREVIEW_MAX_LENGTH
): string | null {
  if (!content) return null;
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/** Resolves auth user emails via the service role client (server-only, never sent to the client). */
async function resolveUserEmails(userIds: string[]): Promise<Map<string, string>> {
  const emailByUserId = new Map<string, string>();
  const admin = createSupabaseAdminClient();
  if (!admin || userIds.length === 0) return emailByUserId;

  const uniqueIds = [...new Set(userIds)];
  await Promise.all(
    uniqueIds.map(async (id) => {
      const { data } = await admin.auth.admin.getUserById(id);
      if (data.user?.email) emailByUserId.set(id, data.user.email);
    })
  );
  return emailByUserId;
}

type ConversationRow = Conversation & {
  channel: Pick<Channel, 'id' | 'name' | 'type'> | null;
  contact: Pick<Contact, 'id' | 'name' | 'email'> | null;
  messages: { content: string; created_at: string }[] | null;
};

export async function listConversations(
  orgId: string,
  filters: InboxFilters
): Promise<ConversationListItem[]> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('conversations')
    .select(
      '*, channel:channels(id, name, type), contact:contacts(id, name, email), messages(content, created_at)'
    )
    .eq('org_id', orgId);
  if (filters.status !== 'all') {
    query = query.eq('status', filters.status);
  }
  if (filters.channelId !== 'all') {
    query = query.eq('channel_id', filters.channelId);
  }

  const { data } = await query
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('created_at', { referencedTable: 'messages', ascending: false })
    .limit(1, { referencedTable: 'messages' })
    .limit(100);
  const rows = (data ?? []) as unknown as ConversationRow[];

  return rows.map(({ messages, ...conversation }) => ({
    ...conversation,
    last_message_preview: truncatePreview(messages?.[0]?.content ?? null),
  }));
}

type ConversationDetailRow = Conversation & {
  channel: Pick<Channel, 'id' | 'name' | 'type'> | null;
  contact: Contact | null;
};

type NoteRow = {
  id: string;
  content: string;
  author_id: string | null;
  created_at: string;
};

export async function getConversationDetail(
  orgId: string,
  conversationId: string
): Promise<ConversationDetail | null> {
  const supabase = await createSupabaseServerClient();

  const { data: conversationData } = await supabase
    .from('conversations')
    .select('*, channel:channels(id, name, type), contact:contacts(*)')
    .eq('org_id', orgId)
    .eq('id', conversationId)
    .maybeSingle();
  if (!conversationData) return null;

  const { channel, contact, ...conversation } =
    conversationData as unknown as ConversationDetailRow;

  const [{ data: messageData }, { data: noteData }] = await Promise.all([
    supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true }),
    supabase
      .from('notes')
      .select('id, content, author_id, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true }),
  ]);

  const messages = (messageData ?? []) as unknown as Message[];
  const noteRows = (noteData ?? []) as unknown as NoteRow[];

  const emailByUserId = await resolveUserEmails(
    noteRows.map((n) => n.author_id).filter((id): id is string => id !== null)
  );
  const notes: NoteItem[] = noteRows.map((n) => ({
    ...n,
    author_email: n.author_id ? (emailByUserId.get(n.author_id) ?? null) : null,
  }));

  return { conversation, channel, contact, messages, notes };
}

export async function listChannels(orgId: string): Promise<Channel[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('channels')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  return (data ?? []) as unknown as Channel[];
}

export async function listMembers(orgId: string): Promise<MemberOption[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('org_members')
    .select('user_id, role')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  const rows = (data ?? []) as unknown as { user_id: string; role: OrgRole }[];

  const emailByUserId = await resolveUserEmails(rows.map((r) => r.user_id));
  return rows.map((r) => ({
    user_id: r.user_id,
    email: emailByUserId.get(r.user_id) ?? null,
    role: r.role,
  }));
}

export async function listCannedResponses(orgId: string): Promise<CannedResponseItem[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('canned_responses')
    .select('id, org_id, shortcut, content')
    .eq('org_id', orgId)
    .order('shortcut', { ascending: true });
  return (data ?? []) as unknown as CannedResponseItem[];
}
