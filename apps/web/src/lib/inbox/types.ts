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

export type ConversationDetail = {
  conversation: Conversation;
  channel: Pick<Channel, 'id' | 'name' | 'type'> | null;
  contact: Contact | null;
  messages: MessageWithAttachments[];
  notes: NoteItem[];
};

export type InboxFilters = {
  status: ConversationStatus | 'all';
  channelId: string | 'all';
};
