import type { Channel, Contact, Conversation, ConversationStatus, Message } from '@zendori/core';

export type ConversationListItem = Conversation & {
  channel: Pick<Channel, 'id' | 'name' | 'type'> | null;
  contact: Pick<Contact, 'id' | 'name' | 'email'> | null;
  last_message_preview: string | null;
};

export type NoteItem = {
  id: string;
  content: string;
  author_id: string | null;
  created_at: string;
  author_email: string | null;
};

export type MemberOption = {
  user_id: string;
  email: string | null;
  role: 'owner' | 'agent';
};

export type CannedResponseItem = {
  id: string;
  org_id: string;
  shortcut: string;
  content: string;
};

export type MessageAttachment = {
  id: string;
  /** Original filename (basename of the storage path). */
  filename: string;
  mime: string;
  size: number;
  /** Short-lived signed download URL; null when the service role is unavailable. */
  url: string | null;
};

export type MessageWithAttachments = Message & {
  attachments: MessageAttachment[];
};

/** Provenance of a single RAG source used for a draft (kb_sources.uri + a chunk excerpt). */
export type DraftSource = {
  source_id: string;
  uri: string | null;
  snippet: string;
};

/** A pending AI-suggested reply (ai_drafts) shown above the composer (Phase 4 — never auto-sent). */
export type DraftItem = {
  id: string;
  content: string;
  confidence: number;
  sources: DraftSource[];
  model: string;
  created_at: string;
};

/** The channel's assigned agent as shown in the inbox (0011). */
export type AgentInfo = {
  id: string;
  name: string;
  confidence_threshold: number;
  is_active: boolean;
};

export type ConversationDetail = {
  conversation: Conversation;
  channel: Pick<Channel, 'id' | 'name' | 'type'> | null;
  /** Agent assigned to the conversation's channel; null = no AI replies. */
  agent: AgentInfo | null;
  contact: Contact | null;
  messages: MessageWithAttachments[];
  notes: NoteItem[];
  /** Newest pending AI draft for this conversation, or null when none is open. */
  draft: DraftItem | null;
};

export type InboxFilters = {
  status: ConversationStatus | 'all';
  channelId: string | 'all';
};

/**
 * Org-level HubSpot info for the inbox sidebar. `ui_domain`/`portal_id` build the
 * ticket deep link; the encrypted token never reaches this type or the client.
 */
export type HubspotSidebarInfo = {
  /** An integration row exists (regardless of whether it is currently active). */
  connected: boolean;
  /** The integration is connected AND active (syncs run). */
  active: boolean;
  ui_domain: string | null;
  portal_id: string | null;
};
