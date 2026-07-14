import Link from 'next/link';
import type { CSSProperties } from 'react';
import { autoAckTextsSchema, businessHoursSchema } from '@zendori/channels';
import type { AutoAckTexts, BusinessHours } from '@zendori/channels';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { saveAiSettings } from './actions';

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

const fieldStyle: CSSProperties = {
  width: '100%',
  padding: '0.55rem 0.75rem',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: '0.95rem',
  background: 'var(--surface)',
};

const timeStyle: CSSProperties = {
  padding: '0.4rem 0.5rem',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: '0.9rem',
  background: 'var(--surface)',
};

const textareaStyle: CSSProperties = {
  ...fieldStyle,
  fontFamily: 'inherit',
  resize: 'vertical',
};

const helpStyle: CSSProperties = {
  fontSize: '0.85rem',
  color: 'var(--text-muted)',
  marginBottom: '1rem',
};

const checkboxRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  fontWeight: 400,
  marginBottom: '0.4rem',
};

type OrgSettingsRow = {
  business_hours?: unknown;
  auto_ack_texts?: unknown;
  escalation_keywords?: unknown;
};

export default async function AiSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, orgs, role } = await requireActiveOrg(org);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const isOwner = role === 'owner';

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('org_settings')
    .select('business_hours, auto_ack_texts, escalation_keywords')
    .eq('org_id', orgId)
    .maybeSingle();
  const settings = (data ?? {}) as OrgSettingsRow;

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

  const disabled = !isOwner;

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Übergabe &amp; Zeiten</h1>
        <p>
          Org-weite Regeln von {orgName} für die Übergabe an Menschen: Eskalations-Keywords,
          Geschäftszeiten und automatische Eingangsbestätigungen. Verhalten, Identität und
          Autopilot der KI konfigurierst du pro Agent unter{' '}
          <Link href={`/settings/agents?org=${orgId}`}>Agenten</Link>.
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
          Nur Owner dürfen diese Einstellungen ändern. Die aktuellen Werte werden schreibgeschützt
          angezeigt.
        </p>
      ) : null}

      <form action={saveAiSettings}>
        <input type="hidden" name="org" value={orgId} />

        <div className="panel">
          <h2>Eskalations-Keywords</h2>
          <p style={helpStyle}>
            Kommagetrennte Liste. Taucht eines dieser Wörter in einer Nachricht auf, wird die
            Konversation an einen Menschen übergeben.
          </p>
          <input
            name="escalation_keywords"
            type="text"
            defaultValue={keywords.join(', ')}
            disabled={disabled}
            placeholder="kündigung, beschwerde, anwalt, datenschutz"
            style={fieldStyle}
          />
        </div>

        <div className="panel">
          <h2>Geschäftszeiten</h2>
          <p style={helpStyle}>
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
              style={fieldStyle}
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
                  <label style={{ ...checkboxRowStyle, minWidth: '9rem', marginBottom: 0 }}>
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
                    style={timeStyle}
                  />
                  <span style={{ color: 'var(--text-muted)' }}>bis</span>
                  <input
                    type="time"
                    name={`bh_${day}_close`}
                    defaultValue={slot?.close ?? '17:00'}
                    disabled={disabled}
                    aria-label={`${weekdayLabels[day]} Schließung`}
                    style={timeStyle}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <h2>Automatische Eingangsbestätigung</h2>
          <p style={helpStyle}>
            Sendet bei einer Übergabe an einen Menschen automatisch eine kurze Bestätigung an den
            Kunden — je nach Geschäftszeiten unterschiedlich.
          </p>
          <label style={checkboxRowStyle}>
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
              style={textareaStyle}
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
              style={textareaStyle}
            />
          </div>
        </div>

        {isOwner ? (
          <button className="primary" type="submit">
            Einstellungen speichern
          </button>
        ) : null}
      </form>
    </div>
  );
}
