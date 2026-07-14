import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import type { Channel, Contact, Conversation, Message, OrgRole } from '@zendori/core';
import type {
  CannedResponseItem,
  ConversationDetail,
  ConversationListItem,
  DraftItem,
  DraftSource,
  HubspotSidebarInfo,
  InboxFilters,
  MemberOption,
  MessageAttachment,
  MessageWithAttachments,
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
  channel:
    | (Pick<Channel, 'id' | 'name' | 'type'> & {
        agent: {
          id: string;
          name: string;
          confidence_threshold: number | string;
          is_active: boolean;
        } | null;
      })
    | null;
  contact: Contact | null;
};

type NoteRow = {
  id: string;
  content: string;
  author_id: string | null;
  created_at: string;
};

type AttachmentRow = {
  id: string;
  message_id: string;
  storage_path: string;
  mime: string;
  size: number;
};

type DraftRow = {
  id: string;
  content: string;
  confidence: number | string;
  sources: unknown;
  model: string;
  created_at: string;
};

/**
 * Defensively normalizes the ai_drafts.sources jsonb (worker-written, so treated
 * as untrusted at this boundary) into typed DraftSource entries.
 */
function parseDraftSources(raw: unknown): DraftSource[] {
  if (!Array.isArray(raw)) return [];
  const sources: DraftSource[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const sourceId = typeof rec.source_id === 'string' ? rec.source_id : null;
    if (!sourceId) continue;
    sources.push({
      source_id: sourceId,
      uri: typeof rec.uri === 'string' ? rec.uri : null,
      snippet: typeof rec.snippet === 'string' ? rec.snippet : '',
    });
  }
  return sources;
}

/** Basename of a storage path (path convention: <org_id>/<message_id>/<filename>). */
function attachmentFilename(storagePath: string): string {
  const parts = storagePath.split('/');
  return parts[parts.length - 1] || storagePath;
}

/**
 * Loads attachments for the given messages and pairs each with a short-lived
 * signed download URL (service role, server-only). Messages without attachments
 * get an empty list — Phase-1 rendering is unaffected.
 */
async function attachMessageAttachments(
  orgId: string,
  messages: Message[]
): Promise<MessageWithAttachments[]> {
  if (messages.length === 0) return [];

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('attachments')
    .select('id, message_id, storage_path, mime, size')
    .eq('org_id', orgId)
    .in(
      'message_id',
      messages.map((m) => m.id)
    );
  const rows = (data ?? []) as unknown as AttachmentRow[];

  // Sign all paths in one batch and force a download disposition: a signed URL
  // must never let a browser inline-render an uploaded HTML/SVG payload.
  const admin = createSupabaseAdminClient();
  const signedUrlByPath = new Map<string, string>();
  if (admin && rows.length > 0) {
    const { data: signed } = await admin.storage.from('attachments').createSignedUrls(
      rows.map((row) => row.storage_path),
      3600,
      { download: true }
    );
    for (const entry of signed ?? []) {
      if (entry.path && entry.signedUrl) signedUrlByPath.set(entry.path, entry.signedUrl);
    }
  }

  const byMessage = new Map<string, MessageAttachment[]>();
  for (const row of rows) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push({
      id: row.id,
      filename: attachmentFilename(row.storage_path),
      mime: row.mime,
      size: row.size,
      url: signedUrlByPath.get(row.storage_path) ?? null,
    });
    byMessage.set(row.message_id, list);
  }

  return messages.map((message) => ({
    ...message,
    attachments: byMessage.get(message.id) ?? [],
  }));
}

export async function getConversationDetail(
  orgId: string,
  conversationId: string
): Promise<ConversationDetail | null> {
  const supabase = await createSupabaseServerClient();

  const { data: conversationData } = await supabase
    .from('conversations')
    .select(
      '*, channel:channels(id, name, type, agent:agents(id, name, confidence_threshold, is_active)), contact:contacts(*)'
    )
    .eq('org_id', orgId)
    .eq('id', conversationId)
    .maybeSingle();
  if (!conversationData) return null;

  const { channel: channelRow, contact, ...conversation } =
    conversationData as unknown as ConversationDetailRow;
  // split the nested agent off the channel (numeric may arrive as string)
  const agent = channelRow?.agent
    ? {
        id: channelRow.agent.id,
        name: channelRow.agent.name,
        confidence_threshold: Number(channelRow.agent.confidence_threshold),
        is_active: channelRow.agent.is_active,
      }
    : null;
  const channel = channelRow
    ? { id: channelRow.id, name: channelRow.name, type: channelRow.type }
    : null;

  const [{ data: messageData }, { data: noteData }, { data: draftData }] = await Promise.all([
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
    // newest pending AI draft (the unique index guarantees at most one pending)
    supabase
      .from('ai_drafts')
      .select('id, content, confidence, sources, model, created_at')
      .eq('org_id', orgId)
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const messageRows = (messageData ?? []) as unknown as Message[];
  const noteRows = (noteData ?? []) as unknown as NoteRow[];
  const draftRow = draftData as unknown as DraftRow | null;
  const draft: DraftItem | null = draftRow
    ? {
        id: draftRow.id,
        content: draftRow.content,
        confidence: Number(draftRow.confidence),
        sources: parseDraftSources(draftRow.sources),
        model: draftRow.model,
        created_at: draftRow.created_at,
      }
    : null;

  const [messages, emailByUserId] = await Promise.all([
    attachMessageAttachments(orgId, messageRows),
    resolveUserEmails(noteRows.map((n) => n.author_id).filter((id): id is string => id !== null)),
  ]);
  const notes: NoteItem[] = noteRows.map((n) => ({
    ...n,
    author_email: n.author_id ? (emailByUserId.get(n.author_id) ?? null) : null,
  }));

  return { conversation, channel, agent, contact, messages, notes, draft };
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

/**
 * Loads the org's HubSpot deep-link info for the inbox sidebar. Reads the
 * integration row (member-scoped RLS) and extracts only ui_domain/portal_id +
 * the active flag — the encrypted token is never returned to the caller/client.
 */
export async function getHubspotSidebarInfo(orgId: string): Promise<HubspotSidebarInfo> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('integrations')
    .select('is_active, config')
    .eq('org_id', orgId)
    .eq('type', 'hubspot')
    .maybeSingle();
  if (!data) return { connected: false, active: false, ui_domain: null, portal_id: null };

  const row = data as { is_active: boolean; config: Record<string, unknown> | null };
  const config = row.config ?? {};
  return {
    connected: true, // a row exists (may be paused)
    active: row.is_active === true,
    ui_domain: typeof config.ui_domain === 'string' ? config.ui_domain : null,
    portal_id: typeof config.portal_id === 'string' ? config.portal_id : null,
  };
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
