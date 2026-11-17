// Client-safe label/badge maps for the Tickets area (imports the pure
// @zendori/core/tickets subpath — never the core barrel, see AppShell.tsx).
import {
  TICKET_ORIGIN_LABELS,
  TICKET_STATUS_LABELS,
  type TicketOrigin,
  type TicketStatus,
} from '@zendori/core/tickets';
import type { ConversationPriority } from '@zendori/core/tickets';
import type { BadgeTone } from '@/components/ui/Badge';

export { TICKET_ORIGIN_LABELS, TICKET_STATUS_LABELS };
export type { TicketOrigin, TicketStatus };

export const TICKET_STATUS_BADGE: Record<TicketStatus, string> = {
  open: 'badge badge--info',
  in_progress: 'badge',
  waiting: 'badge badge--warn',
  resolved: 'badge badge--success',
};

/** Tone of the status <Badge> (redesign): open = info, in progress = accent. */
export const TICKET_STATUS_TONE: Record<TicketStatus, BadgeTone> = {
  open: 'info',
  in_progress: 'accent',
  waiting: 'warn',
  resolved: 'success',
};

export const PRIORITY_LABELS: Record<ConversationPriority, string> = {
  low: 'Niedrig',
  normal: 'Normal',
  high: 'Hoch',
  urgent: 'Dringend',
};

export const PRIORITY_BADGE: Record<ConversationPriority, string> = {
  low: 'badge badge--muted',
  normal: 'badge',
  high: 'badge badge--warn',
  urgent: 'badge badge--danger',
};

export const TICKET_STATUS_ORDER: TicketStatus[] = ['open', 'in_progress', 'waiting', 'resolved'];

/** Tone of the priority <Badge> (redesign). */
export const PRIORITY_TONE: Record<ConversationPriority, BadgeTone> = {
  low: 'muted',
  normal: 'neutral',
  high: 'warn',
  urgent: 'danger',
};
