import Link from 'next/link';
import { requestDraft, returnToBot, takeOverConversation } from '@/app/inbox/actions';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import { href } from '@/lib/href';
import type { ConversationDetail } from '@/lib/inbox/types';
import type { TicketSummary } from '@/lib/tickets/types';
import MessageThread from './MessageThread';

/**
 * Thread column: the 56px head (contact, subject, open ticket, who answers,
 * take over / hand back) and the messages. The hand-off controls live here —
 * next to the conversation they act on — with the same forms and actions the
 * context column used to carry (§6: "Übernehmen" / "An Bot zurückgeben").
 */
export default function ConversationView({
  detail,
  orgId,
  openTicket,
  canOpenTickets,
  filterStatus,
  filterChannel,
  filterQ,
}: {
  detail: ConversationDetail;
  orgId: string;
  /** Phase 11: the conversation's current non-resolved ticket (chip in the header). */
  openTicket?: TicketSummary | null;
  canOpenTickets?: boolean;
  filterStatus: string;
  filterChannel: string;
  filterQ: string;
}) {
  const { conversation, contact, channel, agent, messages } = detail;
  const contactLabel = contact?.name ?? contact?.email ?? 'Unbekannter Kontakt';

  const hiddenFields = (
    <>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="conversationId" value={conversation.id} />
      <input type="hidden" name="filterStatus" value={filterStatus} />
      <input type="hidden" name="filterChannel" value={filterChannel} />
      <input type="hidden" name="filterQ" value={filterQ} />
    </>
  );

  return (
    <>
      <div className="inbox-head inbox-head--thread">
        <div className="inbox-thread-title">
          <h2>{contactLabel}</h2>
          <div className="inbox-thread-sub">
            <span className="truncate">
              {conversation.subject ?? 'Ohne Betreff'}
              {channel ? ` · ${channel.name}` : ''}
            </span>
            {openTicket ? (
              canOpenTickets ? (
                <Link
                  className="badge badge--info"
                  href={href(`/tickets/${openTicket.id}`, { org: orgId })}
                  title="Ticket öffnen"
                >
                  {openTicket.display_id}
                </Link>
              ) : (
                <Badge tone="info">{openTicket.display_id}</Badge>
              )
            ) : null}
          </div>
        </div>
        <div className="inbox-thread-actions">
          {/* who answers this conversation right now */}
          {conversation.mode === 'human' ? (
            <Badge title="Der Bot schweigt, bis die Konversation zurückgegeben wird">Mensch</Badge>
          ) : agent ? (
            <Badge
              tone={agent.is_active ? 'accent' : 'muted'}
              title="Der diesem Kanal zugewiesene KI-Agent"
            >
              <Icon name="ai" size={12} />
              {agent.name}
              {agent.is_active ? '' : ' (pausiert)'}
            </Badge>
          ) : (
            <Badge tone="muted" title="Kein Agent zugewiesen — keine KI-Antworten auf diesem Kanal">
              Kein Agent
            </Badge>
          )}
          {conversation.mode === 'bot' ? (
            <form action={takeOverConversation}>
              {hiddenFields}
              <Button type="submit">Übernehmen</Button>
            </form>
          ) : (
            <>
              <form action={requestDraft}>
                {hiddenFields}
                <Button type="submit" variant="ghost">
                  Entwurf anfordern
                </Button>
              </form>
              <form action={returnToBot}>
                {hiddenFields}
                <Button type="submit">An Bot zurückgeben</Button>
              </form>
            </>
          )}
        </div>
      </div>
      <MessageThread messages={messages} />
    </>
  );
}
