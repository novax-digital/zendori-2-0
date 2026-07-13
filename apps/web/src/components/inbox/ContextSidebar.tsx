'use client';

import type { ConversationPriority, ConversationStatus } from '@zendori/core';
import {
  addNote,
  requestDraft,
  returnToBot,
  setConversationAssignee,
  setConversationStatus,
  syncToHubspot,
  takeOverConversation,
  updateContact,
} from '@/app/inbox/actions';
import type { ConversationDetail, HubspotSidebarInfo, MemberOption } from '@/lib/inbox/types';

const statusOptions: { value: ConversationStatus; label: string }[] = [
  { value: 'open', label: 'Offen' },
  { value: 'pending', label: 'Wartend' },
  { value: 'resolved', label: 'Gelöst' },
];

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
  filterStatus: string;
  filterChannel: string;
};

export default function ContextSidebar({
  orgId,
  detail,
  members,
  hubspot,
  filterStatus,
  filterChannel,
}: ContextSidebarProps) {
  const { conversation, contact, channel, notes } = detail;

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
    </>
  );

  return (
    <div className="inbox-sidebar">
      <section>
        <h3>Kontakt</h3>
        {contact ? (
          // keyed so server-side contact updates re-sync the uncontrolled inputs
          <form
            key={`${contact.id}-${contact.name ?? ''}-${contact.phone ?? ''}`}
            action={updateContact}
            className="inbox-contact-form"
          >
            {hiddenFields}
            <input type="hidden" name="contactId" value={contact.id} />
            <label>
              Name
              <input type="text" name="name" defaultValue={contact.name ?? ''} maxLength={200} />
            </label>
            <div className="inbox-contact-static">
              <span>E-Mail</span>
              <span>{contact.email ?? '—'}</span>
            </div>
            <label>
              Telefon
              <input type="text" name="phone" defaultValue={contact.phone ?? ''} maxLength={50} />
            </label>
            <button className="ghost" type="submit">
              Kontakt speichern
            </button>
          </form>
        ) : (
          <p className="inbox-sidebar-empty">Kein Kontakt verknüpft.</p>
        )}
      </section>

      <section>
        <h3>Status</h3>
        <form action={setConversationStatus} className="inbox-status-buttons">
          {hiddenFields}
          {statusOptions.map((option) => {
            const isActive = conversation.status === option.value;
            return (
              <button
                key={option.value}
                type="submit"
                name="status"
                value={option.value}
                disabled={isActive}
                className={
                  isActive
                    ? `inbox-status-btn inbox-status-btn-active-${option.value}`
                    : 'inbox-status-btn'
                }
              >
                {option.label}
              </button>
            );
          })}
        </form>
      </section>

      <section>
        <h3>Zuweisung</h3>
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
      </section>

      <section>
        <h3>Priorität</h3>
        <span className="inbox-badge inbox-badge-neutral">
          {priorityLabels[conversation.priority]}
        </span>
      </section>

      <section>
        <h3>Kanal &amp; Modus</h3>
        <div className="inbox-badges-row">
          {channel ? <span className="inbox-badge inbox-badge-neutral">{channel.name}</span> : null}
          <span className="inbox-badge inbox-badge-mode">
            {conversation.mode === 'bot' ? 'Bot' : 'Mensch'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
          {conversation.mode === 'bot' ? (
            <form action={takeOverConversation}>
              {hiddenFields}
              <button className="primary" type="submit">
                Übernehmen
              </button>
            </form>
          ) : (
            <>
              <form action={returnToBot}>
                {hiddenFields}
                <button className="ghost" type="submit">
                  An Bot zurückgeben
                </button>
              </form>
              <form action={requestDraft}>
                {hiddenFields}
                <button className="ghost" type="submit">
                  Entwurf anfordern
                </button>
              </form>
            </>
          )}
        </div>
      </section>

      <section>
        <h3>HubSpot</h3>
        {!hubspot.connected ? (
          <p className="inbox-sidebar-empty">
            Nicht verbunden — unter Einstellungen → Integrationen einrichten.
          </p>
        ) : !hubspot.active ? (
          <p className="inbox-sidebar-empty">Verbunden, aber deaktiviert — Sync ist pausiert.</p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <form action={syncToHubspot}>
            {hiddenFields}
            <button className="ghost" type="submit">
              An HubSpot senden
            </button>
          </form>
        </div>
        {hubspotTicketUrl ? (
          <a
            href={hubspotTicketUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'inline-block', marginTop: '0.6rem', fontSize: '0.9rem' }}
          >
            In HubSpot öffnen
          </a>
        ) : null}
      </section>

      <section>
        <h3>Interne Notizen</h3>
        {notes.length === 0 ? (
          <p className="inbox-sidebar-empty">Noch keine Notizen.</p>
        ) : (
          notes.map((note) => (
            <div key={note.id} className="inbox-note">
              <div>{note.content}</div>
              <div className="inbox-note-meta">
                {note.author_email ?? 'Unbekannt'} · {formatDateTime(note.created_at)}
              </div>
            </div>
          ))
        )}
        <form action={addNote} className="inbox-note-form">
          {hiddenFields}
          <textarea
            name="content"
            rows={3}
            placeholder="Interne Notiz — für Kunden nicht sichtbar"
            required
          />
          <button className="ghost" type="submit">
            Notiz speichern
          </button>
        </form>
      </section>
    </div>
  );
}
