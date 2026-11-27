'use client';

import Link from 'next/link';
import type { ConversationPriority, ConversationStatus } from '@zendori/core';
import { TICKET_ORIGIN_LABELS, TICKET_STATUS_LABELS } from '@/lib/tickets/labels';
import type { TicketSummary } from '@/lib/tickets/types';
import {
  addNote,
  createTicketFromConversation,
  syncConversationTicketToHubspot,
  setConversationAssignee,
  setConversationStatus,
  syncToHubspot,
  updateContact,
} from '@/app/inbox/actions';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ChannelIcon from '@/components/ui/ChannelIcon';
import { Field } from '@/components/ui/Field';
import { Avatar, Property, PropertyList } from '@/components/ui/Layout';
import { href } from '@/lib/href';
import type { ConversationDetail, HubspotSidebarInfo, MemberOption } from '@/lib/inbox/types';

const BASE_STATUS_OPTIONS: { value: ConversationStatus; label: string }[] = [
  { value: 'open', label: 'Offen' },
  { value: 'pending', label: 'Wartend' },
  { value: 'resolved', label: 'Gelöst' },
];

// 'An HubSpot gesendet' exists only while a HubSpot integration is active: the
// ticket is worked over there, so the conversation leaves the §6 waiting queue.
// A conversation already carrying the status keeps showing it even after the
// integration was switched off (render truth, don't hide state).
const HUBSPOT_STATUS_OPTION: { value: ConversationStatus; label: string } = {
  value: 'hubspot_sent',
  label: 'An HubSpot gesendet',
};

// urgent/high stand out; normal/low stay calm
const PRIORITY_TONE: Record<string, BadgeTone> = {
  urgent: 'danger',
  high: 'warn',
  normal: 'muted',
  low: 'muted',
};

const priorityLabels: Record<ConversationPriority, string> = {
  low: 'Niedrig',
  normal: 'Normal',
  high: 'Hoch',
  urgent: 'Dringend',
};

/** Fixed German timezone so server-rendered timestamps match what agents expect. */
function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin',
  });
}

type ContextSidebarProps = {
  orgId: string;
  detail: ConversationDetail;
  members: MemberOption[];
  hubspot: HubspotSidebarInfo;
  /** Phase 11: the conversation's tickets, newest first. */
  tickets: TicketSummary[];
  /** May this member open the Tickets area (chips become links)? */
  canOpenTickets: boolean;
  filterStatus: string;
  filterChannel: string;
  filterQ: string;
};

export default function ContextSidebar({
  orgId,
  detail,
  members,
  hubspot,
  tickets,
  canOpenTickets,
  filterStatus,
  filterChannel,
  filterQ,
}: ContextSidebarProps) {
  const { conversation, contact, channel, agent, notes } = detail;

  // HubSpot ticket id lives in conversation.external_refs (§5); deep link needs
  // the org's ui_domain + portal_id from the integration config.
  const rawTicketId = conversation.external_refs.hubspot_ticket_id;
  const hubspotTicketId = typeof rawTicketId === 'string' ? rawTicketId : null;
  const hubspotTicketUrl =
    hubspotTicketId && hubspot.ui_domain && hubspot.portal_id
      ? `https://${hubspot.ui_domain}/contacts/${hubspot.portal_id}/ticket/${encodeURIComponent(
          hubspotTicketId
        )}`
      : null;

  const hiddenFields = (
    <>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="conversationId" value={conversation.id} />
      <input type="hidden" name="filterStatus" value={filterStatus} />
      <input type="hidden" name="filterChannel" value={filterChannel} />
      <input type="hidden" name="filterQ" value={filterQ} />
    </>
  );

  const contactLabel = contact?.name ?? contact?.email ?? 'Unbekannter Kontakt';
  // Tried out from the channel's "Test" tab (0050): no tickets, no HubSpot.
  const isTest = conversation.is_test === true;
  const statusOptions =
    hubspot.active || conversation.status === 'hubspot_sent'
      ? [...BASE_STATUS_OPTIONS, HUBSPOT_STATUS_OPTION]
      : BASE_STATUS_OPTIONS;

  return (
    <div className="inbox-context">
      <section className="rail-section">
        <h3>Kontakt</h3>
        {contact ? (
          // keyed so server-side contact updates re-sync the uncontrolled inputs
          <form
            key={`${contact.id}-${contact.name ?? ''}-${contact.email ?? ''}-${contact.phone ?? ''}-${contact.callback_phone ?? ''}-${contact.company ?? ''}`}
            action={updateContact}
            className="inbox-contact"
          >
            {hiddenFields}
            <input type="hidden" name="contactId" value={contact.id} />
            <div className="inbox-contact-head">
              <Avatar name={contactLabel} size="md" />
              <div className="inbox-contact-name">
                <span className="strong truncate">{contactLabel}</span>
                {contact.company ? (
                  <span className="muted small truncate">{contact.company}</span>
                ) : null}
              </div>
            </div>
            <Field label="Name" htmlFor="inbox-contact-name">
              <input
                id="inbox-contact-name"
                type="text"
                name="name"
                defaultValue={contact.name ?? ''}
                maxLength={200}
              />
            </Field>
            <Field label="Unternehmen" htmlFor="inbox-contact-company">
              <input
                id="inbox-contact-company"
                type="text"
                name="company"
                defaultValue={contact.company ?? ''}
                maxLength={200}
              />
            </Field>
            <Field label="E-Mail" htmlFor="inbox-contact-email">
              <input
                id="inbox-contact-email"
                type="email"
                name="email"
                defaultValue={contact.email ?? ''}
                maxLength={200}
              />
            </Field>
            <Field label="Telefon" htmlFor="inbox-contact-phone">
              <input
                id="inbox-contact-phone"
                type="text"
                name="phone"
                defaultValue={contact.phone ?? ''}
                maxLength={50}
              />
            </Field>
            <Field label="Rückrufnummer" htmlFor="inbox-contact-callback">
              <input
                id="inbox-contact-callback"
                type="text"
                name="callbackPhone"
                defaultValue={contact.callback_phone ?? ''}
                maxLength={50}
                placeholder="nur wenn abweichend von Telefon"
              />
            </Field>
            <Button type="submit" size="sm">
              Kontakt speichern
            </Button>
          </form>
        ) : (
          <p className="muted small">Kein Kontakt verknüpft.</p>
        )}
      </section>

      <section className="rail-section">
        <h3>Konversation</h3>
        <PropertyList>
          <Property label="Status">
            <form action={setConversationStatus}>
              {hiddenFields}
              {/* uncontrolled + keyed by the server value so realtime refreshes re-sync it */}
              <select
                key={conversation.status}
                name="status"
                defaultValue={conversation.status}
                aria-label="Status"
                onChange={(event) => {
                  event.currentTarget.form?.requestSubmit();
                }}
              >
                {statusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </form>
          </Property>
          <Property label="Zuständig">
            <form action={setConversationAssignee}>
              {hiddenFields}
              {/* uncontrolled + keyed by the server value so realtime refreshes re-sync it */}
              <select
                key={conversation.assignee_id ?? 'none'}
                name="assigneeId"
                defaultValue={conversation.assignee_id ?? ''}
                aria-label="Zuständige Person"
                onChange={(event) => {
                  event.currentTarget.form?.requestSubmit();
                }}
              >
                <option value="">Niemand</option>
                {members.map((member) => (
                  <option key={member.user_id} value={member.user_id}>
                    {member.email ?? `${member.user_id.slice(0, 8)}…`}
                  </option>
                ))}
              </select>
            </form>
          </Property>
          <Property label="Priorität">
            <Badge tone={PRIORITY_TONE[conversation.priority] ?? 'muted'}>
              {priorityLabels[conversation.priority]}
            </Badge>
          </Property>
          <Property label="Kanal">
            {channel ? (
              <span className="row row--end">
                <ChannelIcon kind={channel.type} />
                {channel.name}
              </span>
            ) : (
              '—'
            )}
          </Property>
          <Property label="Modus">
            <Badge>{conversation.mode === 'bot' ? 'Bot' : 'Mensch'}</Badge>
          </Property>
          <Property label="Agent">
            <span
              title={
                agent
                  ? 'Der diesem Kanal zugewiesene KI-Agent'
                  : 'Kein Agent zugewiesen — keine KI-Antworten auf diesem Kanal'
              }
            >
              {agent ? `${agent.name}${agent.is_active ? '' : ' (pausiert)'}` : 'Kein Agent'}
            </span>
          </Property>
        </PropertyList>
      </section>

      <section className="rail-section">
        <h3>Tickets</h3>
        {tickets.length === 0 ? (
          <p className="muted small">Kein Ticket zu dieser Konversation.</p>
        ) : (
          <div>
            {tickets.map((ticket) => {
              const title = [ticket.subject, TICKET_ORIGIN_LABELS[ticket.origin]]
                .filter(Boolean)
                .join(' — ');
              return (
                <div key={ticket.id} className="inbox-ticket" title={title}>
                  {canOpenTickets ? (
                    <Link
                      className="inbox-ticket-id"
                      href={href(`/tickets/${ticket.id}`, { org: orgId })}
                    >
                      {ticket.display_id}
                    </Link>
                  ) : (
                    <span className="inbox-ticket-id">{ticket.display_id}</span>
                  )}
                  <Badge tone={ticket.status === 'resolved' ? 'muted' : 'info'}>
                    {TICKET_STATUS_LABELS[ticket.status]}
                  </Badge>
                </div>
              );
            })}
          </div>
        )}
        {isTest ? (
          <p className="muted small">
            Das ist ein Testgespräch. Für Testgespräche werden keine Tickets angelegt.
          </p>
        ) : (
          <div className="row">
            {/* always offered (attach rule v2): a manual ticket is always a NEW one */}
            <form action={createTicketFromConversation}>
              {hiddenFields}
              <Button type="submit" size="sm">
                Ticket anlegen
              </Button>
            </form>
            {/* only with an ACTIVE HubSpot connection — a paused one syncs nothing */}
            {hubspot.active ? (
              <form action={syncConversationTicketToHubspot}>
                {hiddenFields}
                <Button
                  type="submit"
                  size="sm"
                  variant="ghost"
                  title="Legt bei Bedarf ein Ticket an und schickt es an HubSpot (Ticket-Strom)"
                >
                  Ticket an HubSpot senden
                </Button>
              </form>
            ) : null}
          </div>
        )}
      </section>

      {/* HubSpot only appears with an ACTIVE connection (owner decision 2026-11-22).
          Without one the inbox shows nothing of it; a paused connection keeps
          just the link to a ticket that already exists in HubSpot. */}
      {!isTest && (hubspot.active || hubspotTicketUrl) ? (
        <section className="rail-section">
          <h3>HubSpot</h3>
          {!hubspot.active ? (
            <p className="muted small">Verbunden, aber deaktiviert — Sync ist pausiert.</p>
          ) : null}
          <div className="row">
            {hubspot.active ? (
              <form action={syncToHubspot}>
                {hiddenFields}
                <Button type="submit" size="sm">
                  An HubSpot senden
                </Button>
              </form>
            ) : null}
            {hubspotTicketUrl ? (
              <a
                className="small"
                href={hubspotTicketUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                In HubSpot öffnen
              </a>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="rail-section">
        <h3>Interne Notizen</h3>
        {notes.length === 0 ? (
          <p className="muted small">Noch keine Notizen.</p>
        ) : (
          <div className="inbox-notes">
            {notes.map((note) => (
              <div key={note.id} className="inbox-notecard">
                <div>{note.content}</div>
                <div className="inbox-notecard-meta">
                  {note.author_email ?? 'Unbekannt'} · {formatDateTime(note.created_at)}
                </div>
              </div>
            ))}
          </div>
        )}
        <form action={addNote} className="inbox-note-form">
          {hiddenFields}
          <textarea
            name="content"
            rows={3}
            placeholder="Interne Notiz — für Kunden nicht sichtbar"
            aria-label="Interne Notiz"
            required
          />
          <Button type="submit" size="sm">
            Notiz speichern
          </Button>
        </form>
      </section>
    </div>
  );
}
