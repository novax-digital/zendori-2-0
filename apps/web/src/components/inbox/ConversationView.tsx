import Link from 'next/link';
import type { ConversationDetail } from '@/lib/inbox/types';
import type { TicketSummary } from '@/lib/tickets/types';
import MessageThread from './MessageThread';

export default function ConversationView({
  detail,
  orgId,
  openTicket,
  canOpenTickets,
}: {
  detail: ConversationDetail;
  orgId?: string;
  /** Phase 11: the conversation's current non-resolved ticket (chip in the header). */
  openTicket?: TicketSummary | null;
  canOpenTickets?: boolean;
}) {
  const { conversation, contact, channel, messages } = detail;
  const contactLabel = contact?.name ?? contact?.email ?? 'Unbekannter Kontakt';

  return (
    <>
      <div className="inbox-view-header">
        <div className="inbox-view-subject">
          {conversation.subject ?? 'Ohne Betreff'}
          {openTicket ? (
            canOpenTickets && orgId ? (
              <Link
                className="badge badge--info"
                href={`/tickets/${openTicket.id}?org=${orgId}`}
                style={{ marginLeft: '0.5rem', textDecoration: 'none', verticalAlign: 'middle' }}
                title="Ticket öffnen"
              >
                {openTicket.display_id}
              </Link>
            ) : (
              <span
                className="badge badge--info"
                style={{ marginLeft: '0.5rem', verticalAlign: 'middle' }}
              >
                {openTicket.display_id}
              </span>
            )
          ) : null}
        </div>
        <div className="inbox-view-meta">
          {contactLabel}
          {channel ? ` · ${channel.name}` : ''}
        </div>
      </div>
      <MessageThread messages={messages} />
    </>
  );
}
