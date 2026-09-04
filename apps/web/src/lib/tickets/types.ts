import type {
  Channel,
  Contact,
  ConversationPriority,
  Ticket,
  TicketEvent,
  TicketStatus,
} from '@zendori/core';
import type { MessageWithAttachments, NoteItem } from '@/lib/inbox/types';

export type TicketListItem = Ticket & {
  channel: Pick<Channel, 'id' | 'name' | 'type'> | null;
  contact: Pick<Contact, 'id' | 'name' | 'email' | 'company'> | null;
};

/** Compact shape for chips in the inbox sidebar / conversation header. */
export type TicketSummary = Pick<
  Ticket,
  'id' | 'display_id' | 'status' | 'subject' | 'origin' | 'created_at'
>;

export type TicketDetail = {
  ticket: Ticket;
  channel: Pick<Channel, 'id' | 'name' | 'type'> | null;
  contact: Contact | null;
  conversation: { id: string; subject: string | null; status: string; mode: string } | null;
  /** Conversation messages from the ticket's opened_at onwards (its transcript). */
  messages: MessageWithAttachments[];
  /** Messages of the conversation BEFORE opened_at (earlier tickets / history). */
  earlierMessageCount: number;
  notes: NoteItem[];
  events: TicketEvent[];
};

export type TicketStatusFilter = 'active' | TicketStatus | 'all';
export type TicketAssigneeFilter = 'all' | 'me' | 'none';

export type TicketFilters = {
  status: TicketStatusFilter;
  priority: ConversationPriority | 'all';
  assignee: TicketAssigneeFilter;
  channelId: string | 'all';
  /** Search term — '' = no search. */
  q: string;
};

/** Numbering settings as shown on Einstellungen → Tickets; null while 0030 is pending. */
export type TicketSettings = {
  format: string;
  start: number;
  /** A counter row exists ⇒ the start number no longer applies. */
  counterStarted: boolean;
  nextNumber: number;
};
