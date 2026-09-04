import Link from 'next/link';
import {
  DEFAULT_TICKET_ACK_TEXT,
  autoAckTextsSchema,
  businessHoursSchema,
  ticketAckTextsSchema,
} from '@zendori/channels';
import type { AutoAckTexts, BusinessHours, TicketAckTexts } from '@zendori/channels';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { saveAiSettings } from './actions';
import { canViewArea, isAdminRole } from '@zendori/core';
import NoAccessPanel from '@/components/NoAccessPanel';
import SettingsTabs from '@/components/SettingsTabs';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Weekday = (typeof WEEKDAYS)[number];

const weekdayLabels: Record<Weekday, string> = {
  mon: 'Montag',
  tue: 'Dienstag',
  wed: 'Mittwoch',
  thu: 'Donnerstag',
  fri: 'Freitag',
  sat: 'Samstag',
  sun: 'Sonntag',
};

type OrgSettingsRow = {
  business_hours?: unknown;
  auto_ack_texts?: unknown;
  escalation_keywords?: unknown;
  handoff_sla_minutes?: unknown;
  /** 0031 — absent while the migration is pending. */
  ticket_ack_texts?: unknown;
};

export default async function AiSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, orgs, role, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'handoff')) return <NoAccessPanel title="Übergabe & Zeiten" />;
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const isOwner = isAdminRole(role);

  const supabase = await createSupabaseServerClient();
  let settingsRes = await supabase
    .from('org_settings')
    .select('business_hours, auto_ack_texts, escalation_keywords, handoff_sla_minutes, ticket_ack_texts')
    .eq('org_id', orgId)
    .maybeSingle();
  if (settingsRes.error && (settingsRes.error as { code?: string }).code === '42703') {
    // ticket_ack_texts is 0031 — retry without it while the migration is pending
    settingsRes = (await supabase
      .from('org_settings')
      .select('business_hours, auto_ack_texts, escalation_keywords, handoff_sla_minutes')
      .eq('org_id', orgId)
      .maybeSingle()) as typeof settingsRes;
  }
  const settings = (settingsRes.data ?? {}) as OrgSettingsRow;
  const ticketAckParsed = ticketAckTextsSchema.safeParse(settings.ticket_ack_texts ?? {});
  const ticketAck: TicketAckTexts = ticketAckParsed.success
    ? ticketAckParsed.data
    : ticketAckTextsSchema.parse({});

  // parse jsonb / array columns defensively (channels schemas guarantee shape)
  const businessHoursParsed = businessHoursSchema.safeParse(settings.business_hours);
  const businessHours: BusinessHours = businessHoursParsed.success
    ? businessHoursParsed.data
    : { timezone: 'Europe/Berlin', hours: {} };
  const autoAckParsed = autoAckTextsSchema.safeParse(settings.auto_ack_texts);
  const autoAck: AutoAckTexts = autoAckParsed.success
    ? autoAckParsed.data
    : { enabled: false, in_hours: '', out_of_hours: '' };
  const keywords = Array.isArray(settings.escalation_keywords)
    ? (settings.escalation_keywords as unknown[]).filter(
        (keyword): keyword is string => typeof keyword === 'string'
      )
    : [];

  const handoffSlaMinutes =
    typeof settings.handoff_sla_minutes === 'number' ? settings.handoff_sla_minutes : null;

  const disabled = !isOwner;

  return (
    <div className="shell">
      <SettingsTabs active="ai" access={access} orgId={orgId} />

      <div className="page-head">
        <h1>Übergabe &amp; Zeiten</h1>
        <p>
          Org-weite Regeln von {orgName} für Eskalationen: Eskalations-Keywords, Geschäftszeiten
          und die Bestätigungstexte für Übergaben und Tickets. Ob eine Eskalation an einen Menschen
          übergibt oder ein Ticket aufnimmt, Verhalten, Identität und Autopilot konfigurierst du pro
          Agent unter <Link href={`/settings/agents?org=${orgId}`}>Agenten</Link>.
        </p>
      </div>

      {error ? (
        <p className="error" style={{ marginBottom: '1.5rem' }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" style={{ marginBottom: '1.5rem' }}>
          {notice}
        </p>
      ) : null}

      {!isOwner ? (
        <p className="notice" style={{ marginBottom: '1.5rem' }}>
          Nur Inhaber können diese Einstellungen ändern. Die aktuellen Werte werden schreibgeschützt
          angezeigt.
        </p>
      ) : null}

      <form action={saveAiSettings}>
        <input type="hidden" name="org" value={orgId} />

        <div className="panel">
          <h2>Eskalations-Keywords</h2>
          <p className="help">
            Kommagetrennte Liste. Taucht eines dieser Wörter in einer Nachricht auf, wird eskaliert —
            als Übergabe an einen Menschen oder als Ticket, je nach Einstellung des Agenten. Gilt für
            Text-Kanäle UND für den Voice-Agenten am Telefon.
          </p>
          <input
            name="escalation_keywords"
            type="text"
            defaultValue={keywords.join(', ')}
            disabled={disabled}
            placeholder="kündigung, beschwerde, anwalt, datenschutz"
          />
        </div>

        <div className="panel">
          <h2>Geschäftszeiten</h2>
          <p className="help">
            Bestimmen, welcher Auto-Ack-Text verwendet wird. Nicht geöffnete Tage gelten als
            geschlossen.
          </p>
          <div style={{ maxWidth: '20rem', marginBottom: '1.25rem' }}>
            <label htmlFor="timezone">Zeitzone (IANA)</label>
            <input
              id="timezone"
              name="timezone"
              type="text"
              defaultValue={businessHours.timezone}
              disabled={disabled}
              placeholder="Europe/Berlin"
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {WEEKDAYS.map((day) => {
              const slot = businessHours.hours[day];
              return (
                <div
                  key={day}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    flexWrap: 'wrap',
                  }}
                >
                  <label className="check-row" style={{ minWidth: '9rem', marginBottom: 0 }}>
                    <input
                      type="checkbox"
                      name={`bh_${day}_enabled`}
                      defaultChecked={Boolean(slot)}
                      disabled={disabled}
                    />
                    {weekdayLabels[day]}
                  </label>
                  <input
                    type="time"
                    name={`bh_${day}_open`}
                    defaultValue={slot?.open ?? '09:00'}
                    disabled={disabled}
                    aria-label={`${weekdayLabels[day]} Öffnung`}
                  />
                  <span style={{ color: 'var(--text-muted)' }}>bis</span>
                  <input
                    type="time"
                    name={`bh_${day}_close`}
                    defaultValue={slot?.close ?? '17:00'}
                    disabled={disabled}
                    aria-label={`${weekdayLabels[day]} Schließung`}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <h2>SLA-Erinnerung für Übergaben</h2>
          <p className="help">
            Wartet eine Übergabe länger als die angegebene Zeit ohne Reaktion eines Mitarbeiters,
            wird eine interne Notiz an der Konversation hinterlegt. Die Erinnerung feuert nur
            innerhalb der Geschäftszeiten — nachts aufgelaufene Übergaben erinnern kurz nach
            Öffnung. Leer = aus.
          </p>
          <div style={{ maxWidth: '16rem' }}>
            <label htmlFor="handoff_sla_minutes">Erinnerung nach (Minuten)</label>
            <input
              id="handoff_sla_minutes"
              name="handoff_sla_minutes"
              type="number"
              min={5}
              max={1440}
              defaultValue={handoffSlaMinutes ?? ''}
              disabled={disabled}
              placeholder="aus"
            />
          </div>
        </div>

        <div className="panel">
          <h2>Automatische Eingangsbestätigung</h2>
          <p className="help">
            Sendet bei einer Übergabe an einen Menschen automatisch eine kurze Bestätigung an den
            Kunden — je nach Geschäftszeiten unterschiedlich.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              name="ack_enabled"
              defaultChecked={autoAck.enabled}
              disabled={disabled}
            />
            Automatische Eingangsbestätigung aktivieren
          </label>
          <div style={{ marginBottom: '1rem' }}>
            <label htmlFor="ack_in_hours">Text innerhalb der Geschäftszeiten</label>
            <textarea
              id="ack_in_hours"
              name="ack_in_hours"
              rows={3}
              defaultValue={autoAck.in_hours}
              disabled={disabled}
            />
          </div>
          <div>
            <label htmlFor="ack_out_of_hours">Text außerhalb der Geschäftszeiten</label>
            <textarea
              id="ack_out_of_hours"
              name="ack_out_of_hours"
              rows={3}
              defaultValue={autoAck.out_of_hours}
              disabled={disabled}
            />
          </div>

        </div>

        <div className="panel">
          <h2>Ticket-Bestätigung</h2>
          <p className="help">
            Wird gesendet, wenn ein Agent mit „Als Ticket aufnehmen" ein neues Ticket anlegt
            (Text-Kanäle; am Telefon wird keine Nummer genannt). Platzhalter{' '}
            <code>{'{ticket_id}'}</code> = die Ticketnummer. Leere Felder verwenden den Standardtext.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              name="ticket_ack_enabled"
              defaultChecked={ticketAck.enabled}
              disabled={disabled}
            />
            Ticket-Bestätigung senden
          </label>
          <div style={{ marginBottom: '1rem' }}>
            <label htmlFor="ticket_ack_in_hours">Text innerhalb der Geschäftszeiten</label>
            <textarea
              id="ticket_ack_in_hours"
              name="ticket_ack_in_hours"
              rows={3}
              maxLength={1000}
              defaultValue={ticketAck.in_hours}
              placeholder={DEFAULT_TICKET_ACK_TEXT}
              disabled={disabled}
            />
          </div>
          <div>
            <label htmlFor="ticket_ack_out_of_hours">Text außerhalb der Geschäftszeiten</label>
            <textarea
              id="ticket_ack_out_of_hours"
              name="ticket_ack_out_of_hours"
              rows={3}
              maxLength={1000}
              defaultValue={ticketAck.out_of_hours}
              placeholder={DEFAULT_TICKET_ACK_TEXT}
              disabled={disabled}
            />
          </div>

          {isOwner ? (
            <button className="primary" type="submit" style={{ marginTop: '0.25rem' }}>
              Einstellungen speichern
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
