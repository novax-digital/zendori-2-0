import Link from 'next/link';
import { allowedChannelIds, canViewArea, conversationPrioritySchema } from '@zendori/core';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import RealtimeRefresher from '@/components/inbox/RealtimeRefresher';
import TicketFilterBar from '@/components/tickets/TicketFilterBar';
import { channelBadgeClass } from '@/lib/inbox/channel-badge';
import { formatRelativeTime } from '@/lib/inbox/format';
import { listChannels, listMembers } from '@/lib/inbox/queries';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  PRIORITY_BADGE,
  PRIORITY_LABELS,
  TICKET_ORIGIN_LABELS,
  TICKET_STATUS_BADGE,
  TICKET_STATUS_LABELS,
} from '@/lib/tickets/labels';
import { listTickets } from '@/lib/tickets/queries';
import type { TicketAssigneeFilter, TicketFilters, TicketStatusFilter } from '@/lib/tickets/types';

// Tickets area (Phase 11): the work queue. List → detail like agents/channels.

const STATUS_VALUES: TicketStatusFilter[] = ['active', 'open', 'in_progress', 'waiting', 'resolved', 'all'];
const ASSIGNEE_VALUES: TicketAssigneeFilter[] = ['all', 'me', 'none'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const { orgId, access } = await requireActiveOrg(params.org);
  if (!canViewArea(access, 'tickets')) return <NoAccessPanel title="Tickets" />;
  const scope = allowedChannelIds(access);
  const filters = parseFilters(params);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [tickets, channels, members] = await Promise.all([
    listTickets(orgId, filters, user?.id ?? null, scope),
    listChannels(orgId, scope),
    listMembers(orgId),
  ]);
  const memberEmail = new Map(members.map((m) => [m.user_id, m.email]));

  return (
    <div className="shell">
      <RealtimeRefresher orgId={orgId} tables={['tickets']} channelKey="tickets" />
      <div className="page-head">
        <h1>Tickets</h1>
        <p>
          Alle Anliegen, die ein Mensch bearbeitet — aus Übergaben, Telefonaten, Formularen oder
          manuell angelegt. Die Konversation dazu läuft in der Inbox weiter.
        </p>
      </div>
      <DismissibleBanners error={params.error} notice={params.notice} />
      <TicketFilterBar orgId={orgId} filters={filters} channels={channels} />
      <div className="panel" style={{ overflowX: 'auto' }}>
        {tickets.length === 0 ? (
          <p className="hint">Keine Tickets für diese Auswahl.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Betreff</th>
                <th>Kontakt</th>
                <th>Kanal</th>
                <th>Status</th>
                <th>Priorität</th>
                <th>Zuständig</th>
                <th>Aktualisiert</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr key={ticket.id}>
                  <td className="mono">
                    <Link href={`/tickets/${ticket.id}?org=${orgId}`}>{ticket.display_id}</Link>
                  </td>
                  <td>
                    <Link href={`/tickets/${ticket.id}?org=${orgId}`}>
                      {ticket.subject ?? 'Ohne Betreff'}
                    </Link>
                    <div className="hint" style={{ margin: 0 }}>
                      {TICKET_ORIGIN_LABELS[ticket.origin]}
                      {ticket.hubspot_ticket_id ? (
                        <span className="badge badge--hubspot" style={{ marginLeft: '0.4rem' }}>
                          HubSpot
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    {ticket.contact?.name ?? ticket.contact?.email ?? '—'}
                    {ticket.contact?.company ? (
                      <div className="hint" style={{ margin: 0 }}>{ticket.contact.company}</div>
                    ) : null}
                  </td>
                  <td>
                    {ticket.channel ? (
                      <span className={channelBadgeClass(ticket.channel.type)}>{ticket.channel.name}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <span className={TICKET_STATUS_BADGE[ticket.status]}>
                      {TICKET_STATUS_LABELS[ticket.status]}
                    </span>
                  </td>
                  <td>
                    <span className={PRIORITY_BADGE[ticket.priority]}>{PRIORITY_LABELS[ticket.priority]}</span>
                  </td>
                  <td>{ticket.assignee_id ? (memberEmail.get(ticket.assignee_id) ?? '…') : '—'}</td>
                  <td title={ticket.updated_at}>{formatRelativeTime(ticket.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
