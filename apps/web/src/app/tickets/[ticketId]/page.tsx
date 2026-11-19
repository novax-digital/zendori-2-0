import Link from 'next/link';
import { notFound } from 'next/navigation';
import { allowedChannelIds, canEditArea, canViewArea, isAdminRole } from '@zendori/core';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import MessageThread from '@/components/inbox/MessageThread';
import RealtimeRefresher from '@/components/inbox/RealtimeRefresher';
import TicketActionsPanel from '@/components/tickets/TicketActionsPanel';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ChannelIcon from '@/components/ui/ChannelIcon';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import Icon from '@/components/ui/Icon';
import { Avatar, Property, PropertyList, Section } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import { href } from '@/lib/href';
import { formatDateTime } from '@/lib/inbox/format';
import { getHubspotSidebarInfo, listMembers } from '@/lib/inbox/queries';
import { requireActiveOrg } from '@/lib/org';
import {
  PRIORITY_LABELS,
  PRIORITY_TONE,
  TICKET_ORIGIN_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_TONE,
} from '@/lib/tickets/labels';
import { getTicketDetail } from '@/lib/tickets/queries';
import {
  addTicketNote,
  deleteTicket,
  setTicketStatus,
  syncTicketToHubspot,
  updateTicketFields,
} from '../actions';

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
      return `Status: ${TICKET_STATUS_LABELS[to as keyof typeof TICKET_STATUS_LABELS] ?? to}`;
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
  searchParams: Promise<{ org?: string; error?: string; notice?: string; panel?: string }>;
}) {
  const { ticketId } = await params;
  const { org, error, notice, panel } = await searchParams;
  const { orgId, access, role } = await requireActiveOrg(org);
  if (!canViewArea(access, 'tickets')) return <NoAccessPanel title="Tickets" />;
  const scope = allowedChannelIds(access);
  const detail = await getTicketDetail(orgId, ticketId, scope);
  if (!detail) notFound();
  const {
    ticket,
    channel,
    contact,
    conversation,
    messages,
    earlierMessageCount,
    contextMessages,
    notes,
    events,
  } = detail;
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
  const inboxHref = href('/inbox', {
    org: orgId,
    status: 'all',
    channel: 'all',
    c: ticket.conversation_id,
  });
  const listHref = href('/tickets', { org: orgId });
  const selfHref = href(`/tickets/${ticket.id}`, { org: orgId });
  // "Anliegen bearbeiten" drawer (?panel=edit) — its form errors show inside it
  const editing = panel === 'edit' && canEdit;
  const syncPending =
    ticket.hubspot_sync_requested_at !== null &&
    (!ticket.hubspot_synced_at || ticket.hubspot_sync_requested_at > ticket.hubspot_synced_at);
  const contextSummary =
    earlierMessageCount === contextMessages.length
      ? `${earlierMessageCount} Nachricht${earlierMessageCount === 1 ? '' : 'en'} vor dem Ticket`
      : `die letzten ${contextMessages.length} von ${earlierMessageCount} Nachrichten vor dem Ticket`;

  return (
    <div className="page">
      <RealtimeRefresher orgId={orgId} tables={['tickets', 'messages', 'notes']} channelKey="ticket" />
      <PageHeader
        breadcrumb={[{ label: 'Tickets', href: listHref }, { label: ticket.display_id }]}
        title={ticket.subject ?? 'Ohne Betreff'}
        badges={
          <>
            <Badge tone={TICKET_STATUS_TONE[ticket.status]} dot>
              {TICKET_STATUS_LABELS[ticket.status]}
            </Badge>
            <Badge tone={PRIORITY_TONE[ticket.priority]}>{PRIORITY_LABELS[ticket.priority]}</Badge>
          </>
        }
        subtitle={<>Eröffnet am {formatDateTime(ticket.opened_at)}</>}
        actions={
          <>
            {conversation ? <Button href={inboxHref}>In der Inbox öffnen</Button> : null}
            {isOwner ? (
              <Menu label="Weitere Aktionen">
                <form action={deleteTicket}>
                  {hidden}
                  <ConfirmDeleteButton inMenu label="Ticket löschen" confirmLabel="Endgültig löschen" />
                </form>
                <p className="menu-note">
                  Konversation und Nachrichten bleiben erhalten, die Ticketnummer wird nicht neu
                  vergeben. Ein HubSpot-Ticket bleibt in HubSpot bestehen.
                </p>
              </Menu>
            ) : null}
            {canEdit && ticket.status !== 'resolved' ? (
              <Button type="submit" form="ticket-resolve" variant="primary">
                Als erledigt markieren
              </Button>
            ) : null}
          </>
        }
      />

      <div className="page-split">
        <div className="page-body ticket-main">
          <DismissibleBanners
            error={editing ? undefined : error}
            notice={notice}
          />
          {/* target of the page head's "Als erledigt markieren" (form="ticket-resolve") */}
          <form id="ticket-resolve" action={setTicketStatus}>
            {hidden}
            <input type="hidden" name="status" value="resolved" />
          </form>

          <Section
            title="Beschreibung"
            actions={
              canEdit ? (
                <Link href={href(`/tickets/${ticket.id}`, { org: orgId, panel: 'edit' })} scroll={false}>
                  Bearbeiten
                </Link>
              ) : null
            }
          >
            {ticket.description ? (
              <p className="ticket-description">{ticket.description}</p>
            ) : (
              <p className="muted small">Keine Beschreibung.</p>
            )}
          </Section>

          <Section
            title="Verlauf"
            actions={conversation ? <Link href={inboxHref}>In der Inbox antworten</Link> : null}
          >
            {contextMessages.length > 0 ? (
              <details className="ticket-history" open>
                <summary>
                  Vorgeschichte: {contextSummary} (<Link href={inboxHref}>alles in der Inbox</Link>)
                </summary>
                <div className="ticket-thread ticket-thread--context">
                  <MessageThread messages={contextMessages} />
                </div>
              </details>
            ) : null}
            <div className="ticket-thread">
              <MessageThread messages={messages} emptyText="Noch keine Nachrichten zu diesem Ticket." />
            </div>
            {conversation ? null : (
              <p className="muted small">Die Konversation existiert nicht mehr.</p>
            )}
          </Section>

          <Section title="Interne Notizen" help="Nur für das Team sichtbar, nie für den Kunden.">
            {notes.length === 0 ? <p className="muted small">Noch keine Notizen.</p> : null}
            {notes.length > 0 ? (
              <div className="ticket-notes">
                {notes.map((note) => (
                  <div key={note.id} className="ticket-note">
                    {note.content}
                    <div className="ticket-note-meta">
                      {note.author_email ?? 'System'} · {formatDateTime(note.created_at)}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {canEdit ? (
              <form action={addTicketNote} className="stack stack--sm">
                {hidden}
                <textarea
                  name="content"
                  rows={3}
                  maxLength={4000}
                  aria-label="Interne Notiz"
                  placeholder="Interne Notiz schreiben …"
                />
                <div>
                  <Button type="submit">Notiz speichern</Button>
                </div>
              </form>
            ) : null}
          </Section>

          <Section title="Zeitleiste">
            {events.length === 0 && !ticket.resolved_at ? (
              <p className="muted small">Keine Einträge.</p>
            ) : (
              <ul className="ticket-timeline">
                {events.map((event) => (
                  <li key={event.id}>
                    <span className="ticket-timeline-time">{formatDateTime(event.created_at)}</span>
                    <span>{eventText(event.kind, event.details)}</span>
                  </li>
                ))}
                {ticket.resolved_at ? (
                  <li>
                    <span className="ticket-timeline-time">{formatDateTime(ticket.resolved_at)}</span>
                    <span>Erledigt</span>
                  </li>
                ) : null}
              </ul>
            )}
          </Section>
        </div>

        <aside className="page-rail" aria-label="Eigenschaften">
          <div className="rail-section">
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
            {!canEdit ? (
              <p className="muted small">Nur mit Bearbeiten-Recht für Tickets änderbar.</p>
            ) : null}
          </div>

          <div className="rail-section">
            <h2>Details</h2>
            <PropertyList>
              {channel ? (
                <Property label="Kanal">
                  <span className="row">
                    <ChannelIcon kind={channel.type} />
                    {channel.name}
                  </span>
                </Property>
              ) : null}
              <Property label="Herkunft">{TICKET_ORIGIN_LABELS[ticket.origin]}</Property>
              {ticket.category ? <Property label="Kategorie">{ticket.category}</Property> : null}
              <Property label="Eröffnet">{formatDateTime(ticket.opened_at)}</Property>
              {ticket.resolved_at ? (
                <Property label="Erledigt">{formatDateTime(ticket.resolved_at)}</Property>
              ) : null}
            </PropertyList>
          </div>

          <div className="rail-section">
            <h2>Kontakt</h2>
            {contact ? (
              <>
                <div className="row">
                  <Avatar name={contact.name ?? contact.email ?? '?'} size="md" />
                  <div className="grow">
                    <div className="strong truncate">{contact.name ?? 'Ohne Namen'}</div>
                    {contact.company ? (
                      <div className="muted small truncate">{contact.company}</div>
                    ) : null}
                  </div>
                </div>
                <PropertyList>
                  {contact.email ? <Property label="E-Mail">{contact.email}</Property> : null}
                  {contact.phone ? <Property label="Telefon">{contact.phone}</Property> : null}
                  {contact.callback_phone ? (
                    <Property label="Rückruf">{contact.callback_phone}</Property>
                  ) : null}
                </PropertyList>
              </>
            ) : (
              <p className="muted small">Kein Kontakt verknüpft.</p>
            )}
            <Link href={inboxHref} className="small">
              Kontakt in der Inbox bearbeiten
            </Link>
          </div>

          <div className="rail-section">
            <h2>HubSpot</h2>
            {!hubspot.connected ? (
              <p className="muted small">
                Nicht verbunden. Einrichten unter{' '}
                <Link href={href('/settings/integrations', { org: orgId })}>Integrationen</Link>.
              </p>
            ) : (
              <>
                {!hubspot.active ? (
                  <p className="muted small">Verbunden, aber deaktiviert. Der Sync ist pausiert.</p>
                ) : null}
                <div className="row row--between">
                  {ticket.hubspot_ticket_id ? (
                    <Badge tone="hubspot">In HubSpot</Badge>
                  ) : (
                    <Badge tone="muted">Noch nicht übertragen</Badge>
                  )}
                  {canEdit ? (
                    <form action={syncTicketToHubspot}>
                      {hidden}
                      <Button type="submit" size="sm">
                        {ticket.hubspot_ticket_id ? 'Erneut senden' : 'An HubSpot senden'}
                      </Button>
                    </form>
                  ) : null}
                </div>
                {ticket.hubspot_synced_at ? (
                  <p className="muted small">
                    Zuletzt synchronisiert {formatDateTime(ticket.hubspot_synced_at)}
                    {syncPending ? ', neuer Sync ausstehend' : ''}
                  </p>
                ) : syncPending ? (
                  <p className="muted small">Sync ausstehend</p>
                ) : null}
                {hubspotTicketUrl ? (
                  <a
                    href={hubspotTicketUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="row small"
                  >
                    In HubSpot öffnen
                    <Icon name="external" size={14} />
                  </a>
                ) : null}
              </>
            )}
          </div>
        </aside>
      </div>

      {editing ? (
        <Drawer
          title="Anliegen bearbeiten"
          closeHref={selfHref}
          footer={
            <>
              <Button href={selfHref} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="ticket-edit" variant="primary">
                Speichern
              </Button>
            </>
          }
        >
          <DismissibleBanners error={error} />
          <form id="ticket-edit" action={updateTicketFields} className="stack">
            {hidden}
            <input type="hidden" name="panel" value="edit" />
            <Field label="Betreff" htmlFor="ticket-subject">
              <input
                id="ticket-subject"
                type="text"
                name="subject"
                defaultValue={ticket.subject ?? ''}
                maxLength={200}
                required
              />
            </Field>
            <Field label="Beschreibung" htmlFor="ticket-description">
              <textarea
                id="ticket-description"
                name="description"
                rows={10}
                maxLength={4000}
                defaultValue={ticket.description ?? ''}
              />
            </Field>
          </form>
        </Drawer>
      ) : null}
    </div>
  );
}
