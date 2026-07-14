import type { CSSProperties } from 'react';
import { autoAckTextsSchema, businessHoursSchema } from '@zendori/channels';
import type { AutoAckTexts, BusinessHours } from '@zendori/channels';
import type { ChannelType } from '@zendori/core';
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

const channelLabels: Record<ChannelType, string> = {
  chat: 'Chat-Widget',
  email: 'E-Mail',
  whatsapp: 'WhatsApp',
  voice: 'Telefon (Voice)',
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

/** Reads a boolean flag defensively from the autopilot_enabled jsonb. */
function autopilotFor(value: unknown, type: ChannelType): boolean {
  return (
    typeof value === 'object' && value !== null && (value as Record<string, unknown>)[type] === true
  );
}

type OrgSettingsRow = {
  autopilot_enabled?: unknown;
  confidence_threshold?: unknown;
  tone_instructions?: unknown;
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
    .select(
      'autopilot_enabled, confidence_threshold, tone_instructions, business_hours, auto_ack_texts, escalation_keywords'
    )
    .eq('org_id', orgId)
    .maybeSingle();
  const settings = (data ?? {}) as OrgSettingsRow;

  // parse jsonb / array columns defensively (channels schemas guarantee shape)
  const confidence =
    typeof settings.confidence_threshold === 'number' ? settings.confidence_threshold : 0.7;
  const tone = typeof settings.tone_instructions === 'string' ? settings.tone_instructions : '';
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
          Nur Owner dürfen die KI-Einstellungen ändern. Die aktuellen Werte werden schreibgeschützt
          angezeigt.
        </p>
      ) : null}

      <form action={saveAiSettings}>
        <input type="hidden" name="org" value={orgId} />

        <div className="panel">
          <h2>KI &amp; Autopilot — {orgName}</h2>
          <p style={helpStyle}>
            Der Autopilot sendet KI-Antworten nur dann automatisch, wenn er pro Kanal aktiviert ist
            und die Sicherheit des Vorschlags über dem Schwellwert liegt. Andernfalls bleibt die
            Antwort ein Vorschlag in der Inbox.
          </p>

          <div style={{ maxWidth: '16rem', marginBottom: '1.25rem' }}>
            <label htmlFor="confidence_threshold">Sicherheits-Schwellwert (0–1)</label>
            <input
              id="confidence_threshold"
              name="confidence_threshold"
              type="number"
              min={0}
              max={1}
              step={0.05}
              defaultValue={confidence}
              disabled={disabled}
              required
              style={fieldStyle}
            />
          </div>

          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              Autopilot pro Kanal
            </legend>
            {(Object.keys(channelLabels) as ChannelType[]).map((type) => (
              <label key={type} style={checkboxRowStyle}>
                <input
                  type="checkbox"
                  name={`autopilot_${type}`}
                  defaultChecked={autopilotFor(settings.autopilot_enabled, type)}
                  disabled={disabled}
                />
                {channelLabels[type]}
              </label>
            ))}
          </fieldset>
        </div>

        <div className="panel">
          <h2>Ton-Vorgaben</h2>
          <p style={helpStyle}>
            Optionale Vorgaben für Tonfall und Stil der KI-Antworten (z. B. „freundlich, siezen,
            kurz halten").
          </p>
          <textarea
            name="tone_instructions"
            rows={4}
            defaultValue={tone}
            disabled={disabled}
            maxLength={4000}
            style={textareaStyle}
            aria-label="Ton-Vorgaben"
          />
        </div>

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
