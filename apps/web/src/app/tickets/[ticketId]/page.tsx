import Link from 'next/link';
import { notFound } from 'next/navigation';
import { allowedChannelIds, canEditArea, canViewArea, isAdminRole } from '@zendori/core';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import MessageThread from '@/components/inbox/MessageThread';
import RealtimeRefresher from '@/components/inbox/RealtimeRefresher';
import TicketActionsPanel from '@/components/tickets/TicketActionsPanel';
import { channelBadgeClass } from '@/lib/inbox/channel-badge';
import { formatDateTime } from '@/lib/inbox/format';
import { getHubspotSidebarInfo, listMembers } from '@/lib/inbox/queries';
import { requireActiveOrg } from '@/lib/org';
import {
  PRIORITY_BADGE,
  PRIORITY_LABELS,
  TICKET_ORIGIN_LABELS,
  TICKET_STATUS_BADGE,
  TICKET_STATUS_LABELS,
} from '@/lib/tickets/labels';
import { getTicketDetail } from '@/lib/tickets/queries';
import { addTicketNote, deleteTicket, syncTicketToHubspot, updateTicketFields } from '../actions';

// Ticket detail (Phase 11): the work item plus its transcript slice.

function eventText(kind: string, details: Record<string, unknown>): string {
  const origin = typeof details.origin === 'string' ? details.origin : null;
  switch (kind) {
    case 'created':
      return `Angelegt${origin ? ` (${TICKET_ORIGIN_LABELS[origin as keyof typeof TICKET_ORIGIN_LABELS] ?? origin})` : ''}`;
    case 'attached':
      return `Neuer Anlass angehängt${origin ? ` (${TICKET_ORIGIN_LABELS[origin as keyof typeof TICKET_ORIGIN_LABELS] ?? origin})` : ''}`;
    case 'status_changed': {
      const to = typeof details.to === 'string' ? details.to : '';
      return `Status → ${TICKET_STATUS_LABELS[to as keyof typeof TICKET_STATUS_LABELS] ?? to}`;
    }
    case 'assigned':
      return details.assignee_id ? 'Zugewiesen' : 'Zuweisung entfernt';
    case 'hubspot_synced':
      return 'An HubSpot übertragen';
    case 'note':
      return 'Interne Notiz';
    default:
      return kind;
  }
}

export default async function TicketDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketId: string }>;
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { ticketId } = await params;
  const { org, error, notice } = await searchParams;
  const { orgId, access, role } = await requireActiveOrg(org);
  if (!canViewArea(access, 'tickets')) return <NoAccessPanel title="Tickets" />;
  const scope = allowedChannelIds(access);
  const detail = await getTicketDetail(orgId, ticketId, scope);
  if (!detail) notFound();
  const { ticket, channel, contact, conversation, messages, earlierMessageCount, notes, events } = detail;
  const canEdit = canEditArea(access, 'tickets');
  const isOwner = isAdminRole(role);
  const [members, hubspot] = await Promise.all([listMembers(orgId), getHubspotSidebarInfo(orgId)]);
  const hubspotTicketUrl =
    ticket.hubspot_ticket_id && hubspot.ui_domain && hubspot.portal_id
      ? `https://${hubspot.ui_domain}/contacts/${hubspot.portal_id}/ticket/${encodeURIComponent(ticket.hubspot_ticket_id)}`
      : null;
  const hidden = (
    <>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="ticketId" value={ticket.id} />
    </>
  );
  const inboxHref = `/inbox?org=${orgId}&status=all&channel=all&c=${ticket.conversation_id}`;

  return (
    <div className="shell">
      <RealtimeRefresher orgId={orgId} tables={['tickets', 'messages', 'notes']} channelKey="ticket" />
      <div className="page-head">
        <p style={{ margin: '0 0 0.25rem' }}>
          <Link href={`/tickets?org=${orgId}`}>← Alle Tickets</Link>
        </p>
        <h1>
          <span className="mono">{ticket.display_id}</span> {ticket.subject ?? 'Ohne Betreff'}
        </h1>
        <div className="inbox-badges-row" style={{ flexWrap: 'wrap' }}>
          <span className={TICKET_STATUS_BADGE[ticket.status]}>{TICKET_STATUS_LABELS[ticket.status]}</span>
          <span className={PRIORITY_BADGE[ticket.priority]}>{PRIORITY_LABELS[ticket.priority]}</span>
          {channel ? <span className={channelBadgeClass(channel.type)}>{channel.name}</span> : null}
          <span className="badge badge--muted">{TICKET_ORIGIN_LABELS[ticket.origin]}</span>
          <span className="hint" style={{ margin: 0 }}>
            eröffnet {formatDateTime(ticket.opened_at)}
          </span>
        </div>
      </div>
      <DismissibleBanners error={error} notice={notice} />

      <div className="panel">
        <h2>Bearbeitung</h2>
        <TicketActionsPanel
          orgId={orgId}
          ticketId={ticket.id}
          status={ticket.status}
          priority={ticket.priority}
          assigneeId={ticket.assignee_id}
          members={members}
          disabled={!canEdit}
        />
        {!canEdit ? <p className="hint">Nur mit Bearbeiten-Recht für Tickets änderbar.</p> : null}
      </div>

      <div className="panel">
        <h2>Anliegen</h2>
        <form action={updateTicketFields} className="stack">
          {hidden}
          <label>
            Betreff
            <input type="text" name="subject" defaultValue={ticket.subject ?? ''} maxLength={200} disabled={!canEdit} />
          </label>
          <label>
            Beschreibung
            <textarea name="description" rows={5} maxLength={4000} defaultValue={ticket.description ?? ''} disabled={!canEdit} />
          </label>
          {ticket.category ? <p className="hint">Kategorie: {ticket.category}</p> : null}
          {canEdit ? (
            <div>
              <button type="submit">Speichern</button>
            </div>
          ) : null}
        </form>
      </div>

      <div className="panel">
        <h2>Kontakt</h2>
        {contact ? (
          <div className="stack" style={{ gap: '0.2rem' }}>
            <div>{contact.name ?? '—'}</div>
            {contact.company ? <div className="hint" style={{ margin: 0 }}>{contact.company}</div> : null}
            {contact.email ? <div>{contact.email}</div> : null}
            {contact.phone ? <div>{contact.phone}</div> : null}
            {contact.callback_phone ? <div>Rückruf: {contact.callback_phone}</div> : null}
          </div>
        ) : (
          <p className="hint">Kein Kontakt verknüpft.</p>
        )}
        <p className="hint">
          <Link href={inboxHref}>Kontakt in der Inbox bearbeiten</Link>
        </p>
      </div>

      <div className="panel">
        <h2>Verlauf</h2>
        {earlierMessageCount > 0 ? (
          <p className="hint">
            {earlierMessageCount} frühere Nachricht{earlierMessageCount === 1 ? '' : 'en'} dieser
            Konversation gehören nicht zu diesem Ticket — <Link href={inboxHref}>in der Inbox öffnen</Link>.
          </p>
        ) : null}
        <div className="ticket-transcript">
          <MessageThread messages={messages} emptyText="Noch keine Nachrichten zu diesem Ticket." />
        </div>
        <p className="hint">
          {conversation ? (
            <Link href={inboxHref}>Konversation in der Inbox öffnen</Link>
          ) : (
            'Die Konversation existiert nicht mehr.'
          )}
        </p>
      </div>

      <div className="panel">
        <h2>HubSpot</h2>
        {!hubspot.connected ? (
          <p className="hint">Nicht verbunden — unter Einstellungen → Integrationen einrichten.</p>
        ) : (
          <div className="stack" style={{ gap: '0.5rem' }}>
            {!hubspot.active ? (
              <p className="hint">Verbunden, aber deaktiviert — der Sync ist pausiert.</p>
            ) : null}
            <div className="inbox-badges-row" style={{ flexWrap: 'wrap' }}>
              {ticket.hubspot_ticket_id ? (
                <span className="badge badge--hubspot">In HubSpot</span>
              ) : (
                <span className="badge badge--muted">Noch nicht übertragen</span>
              )}
              {ticket.hubspot_synced_at ? (
                <span className="hint" style={{ margin: 0 }}>
                  zuletzt synchronisiert {formatDateTime(ticket.hubspot_synced_at)}
                </span>
              ) : null}
              {ticket.hubspot_sync_requested_at &&
              (!ticket.hubspot_synced_at || ticket.hubspot_sync_requested_at > ticket.hubspot_synced_at) ? (
                <span className="hint" style={{ margin: 0 }}>· Sync ausstehend</span>
              ) : null}
            </div>
            <div className="inbox-badges-row" style={{ flexWrap: 'wrap' }}>
              {canEdit ? (
                <form action={syncTicketToHubspot}>
                  {hidden}
                  <button className="ghost" type="submit">
                    {ticket.hubspot_ticket_id ? 'Erneut an HubSpot senden' : 'An HubSpot senden'}
                  </button>
                </form>
              ) : null}
              {hubspotTicketUrl ? (
                <a href={hubspotTicketUrl} target="_blank" rel="noopener noreferrer">
                  In HubSpot öffnen
                </a>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Interne Notizen</h2>
        {notes.length === 0 ? <p className="hint">Noch keine Notizen.</p> : null}
        {notes.map((note) => (
          <div key={note.id} style={{ marginBottom: '0.75rem' }}>
            <div style={{ whiteSpace: 'pre-wrap' }}>{note.content}</div>
            <div className="hint" style={{ margin: 0 }}>
              {note.author_email ?? 'System'} · {formatDateTime(note.created_at)}
            </div>
          </div>
        ))}
        {canEdit ? (
          <form action={addTicketNote} className="stack">
            {hidden}
            <textarea name="content" rows={3} maxLength={4000} placeholder="Interne Notiz — nie an den Kunden" />
            <div>
              <button type="submit" className="ghost">
                Notiz speichern
              </button>
            </div>
          </form>
        ) : null}
      </div>

      <div className="panel">
        <h2>Zeitleiste</h2>
        {events.length === 0 ? <p className="hint">Keine Einträge.</p> : null}
        <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
          {events.map((event) => (
            <li key={event.id}>
              {formatDateTime(event.created_at)} — {eventText(event.kind, event.details)}
            </li>
          ))}
          {ticket.resolved_at ? <li>{formatDateTime(ticket.resolved_at)} — Erledigt</li> : null}
        </ul>
      </div>

      {isOwner ? (
        <div className="panel">
          <h2>Ticket löschen</h2>
          <form action={deleteTicket}>
            {hidden}
            <ConfirmDeleteButton label="Ticket löschen" confirmLabel="Endgültig löschen" />
            <p style={{ fontSize: '0.8rem', color: 'var(--text-subtle)', marginTop: '0.4rem' }}>
              Die Konversation und ihre Nachrichten bleiben erhalten; die Ticketnummer wird nicht neu
              vergeben. Ein bereits angelegtes HubSpot-Ticket bleibt in HubSpot bestehen.
            </p>
          </form>
        </div>
      ) : null}
    </div>
  );
}
