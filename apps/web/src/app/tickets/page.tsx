import Link from 'next/link';
import { allowedChannelIds, canViewArea, conversationPrioritySchema } from '@zendori/core';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import RealtimeRefresher from '@/components/inbox/RealtimeRefresher';
import TicketFilterBar, { ticketStatusTabs } from '@/components/tickets/TicketFilterBar';
import Badge from '@/components/ui/Badge';
import ChannelIcon from '@/components/ui/ChannelIcon';
import { Avatar, EmptyState, Tabs } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import { href } from '@/lib/href';
import { formatRelativeTime } from '@/lib/inbox/format';
import { listChannels, listMembers } from '@/lib/inbox/queries';
import { requireActiveOrg } from '@/lib/org';
import {
  PRIORITY_LABELS,
  PRIORITY_TONE,
  TICKET_ORIGIN_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_TONE,
} from '@/lib/tickets/labels';
import { countTicketsByStatus, listTickets } from '@/lib/tickets/queries';
import type { TicketAssigneeFilter, TicketFilters, TicketStatusFilter } from '@/lib/tickets/types';

// Tickets area (Phase 11): the work queue. List → detail like agents/channels.

const STATUS_VALUES: TicketStatusFilter[] = ['active', 'open', 'in_progress', 'waiting', 'resolved', 'all'];
const ASSIGNEE_VALUES: TicketAssigneeFilter[] = ['all', 'me', 'none'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** listTickets returns at most this many rows (newest first). */
const LIST_LIMIT = 100;

function parseFilters(params: {
  status?: string;
  priority?: string;
  assignee?: string;
  channel?: string;
  q?: string;
}): TicketFilters {
  const priority = conversationPrioritySchema.safeParse(params.priority);
  return {
    status: STATUS_VALUES.includes(params.status as TicketStatusFilter)
      ? (params.status as TicketStatusFilter)
      : 'active',
    priority: priority.success ? priority.data : 'all',
    assignee: ASSIGNEE_VALUES.includes(params.assignee as TicketAssigneeFilter)
      ? (params.assignee as TicketAssigneeFilter)
      : 'all',
    channelId: params.channel && UUID_RE.test(params.channel) ? params.channel : 'all',
    q: (params.q ?? '').trim().slice(0, 200),
  };
}

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{
    org?: string;
    status?: string;
    priority?: string;
    assignee?: string;
    channel?: string;
    q?: string;
    error?: string;
    notice?: string;
  }>;
}) {
  const params = await searchParams;
  const { orgId, access, userId } = await requireActiveOrg(params.org);
  if (!canViewArea(access, 'tickets')) return <NoAccessPanel title="Tickets" />;
  const scope = allowedChannelIds(access);
  const filters = parseFilters(params);

  const [tickets, counts, channels, members] = await Promise.all([
    listTickets(orgId, filters, userId, scope),
    countTicketsByStatus(orgId, filters, userId, scope),
    listChannels(orgId, scope),
    listMembers(orgId),
  ]);
  const memberEmail = new Map(members.map((m) => [m.user_id, m.email]));

  return (
    <div className="page">
      <RealtimeRefresher orgId={orgId} tables={['tickets']} channelKey="tickets" />
      <PageHeader
        title="Tickets"
        subtitle="Anliegen, die ein Mensch bearbeitet. Die Konversation dazu läuft in der Inbox weiter."
        tabs={<Tabs label="Status" items={ticketStatusTabs(orgId, filters, counts)} />}
      />
      <div className="page-body">
        <DismissibleBanners error={params.error} notice={params.notice} />
        <TicketFilterBar orgId={orgId} filters={filters} channels={channels} />
        {tickets.length === 0 ? (
          <EmptyState title="Keine Tickets" text="Für diese Auswahl gibt es keine Tickets." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="ticket-table">
                <thead>
                  <tr>
                    <th>Nr.</th>
                    <th className="ticket-col-subject">Betreff</th>
                    <th>Kontakt</th>
                    <th>Kanal</th>
                    <th>Status</th>
                    <th>Priorität</th>
                    <th>Zuständig</th>
                    <th className="right">Aktualisiert</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((ticket) => {
                    const detailHref = href(`/tickets/${ticket.id}`, { org: orgId });
                    const assignee = ticket.assignee_id
                      ? (memberEmail.get(ticket.assignee_id) ?? null)
                      : null;
                    return (
                      <tr key={ticket.id}>
                        <td className="mono muted nowrap">{ticket.display_id}</td>
                        <td>
                          <Link href={detailHref} className="cell-title">
                            {ticket.subject ?? 'Ohne Betreff'}
                          </Link>
                          <div className="row">
                            <span className="cell-sub">{TICKET_ORIGIN_LABELS[ticket.origin]}</span>
                            {ticket.hubspot_ticket_id ? <Badge tone="hubspot">HubSpot</Badge> : null}
                          </div>
                        </td>
                        <td>
                          {ticket.contact?.name ?? ticket.contact?.email ?? (
                            <span className="muted">Kein Kontakt</span>
                          )}
                          {ticket.contact?.company ? (
                            <div className="cell-sub">{ticket.contact.company}</div>
                          ) : null}
                        </td>
                        <td>
                          {ticket.channel ? (
                            <div className="cell-main">
                              <ChannelIcon kind={ticket.channel.type} />
                              <span className="truncate">{ticket.channel.name}</span>
                            </div>
                          ) : (
                            <span className="muted">Kein Kanal</span>
                          )}
                        </td>
                        <td>
                          <Badge tone={TICKET_STATUS_TONE[ticket.status]} dot>
                            {TICKET_STATUS_LABELS[ticket.status]}
                          </Badge>
                        </td>
                        <td>
                          <Badge tone={PRIORITY_TONE[ticket.priority]}>
                            {PRIORITY_LABELS[ticket.priority]}
                          </Badge>
                        </td>
                        <td>
                          {ticket.assignee_id ? (
                            <div className="cell-main">
                              <Avatar name={assignee ?? '?'} />
                              <span className="truncate">{assignee ?? 'Unbekannt'}</span>
                            </div>
                          ) : (
                            <span className="muted">Nicht zugewiesen</span>
                          )}
                        </td>
                        <td className="right muted nowrap" title={ticket.updated_at}>
                          {formatRelativeTime(ticket.updated_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {tickets.length >= LIST_LIMIT ? (
              <p className="muted small ticket-list-note">
                Angezeigt werden die {LIST_LIMIT} zuletzt aktualisierten Tickets. Mit Suche und
                Filtern grenzt du die Liste ein.
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
