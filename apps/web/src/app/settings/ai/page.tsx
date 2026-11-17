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
import { href } from '@/lib/href';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import SettingsFrame from '@/components/SettingsTabs';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { Field, SettingRow } from '@/components/ui/Field';
import { Section } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';

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
    <SettingsFrame access={access} orgId={orgId}>
      <div className="page">
        <PageHeader
          title="Übergabe & Zeiten"
          subtitle={`Org-weite Regeln von ${orgName} für Eskalationen: Keywords, Geschäftszeiten und Bestätigungstexte.`}
        />

        <div className="page-body">
          <DismissibleBanners error={error} notice={notice} />

          {!isOwner ? (
            <Callout>
              Nur Inhaber können diese Einstellungen ändern. Die aktuellen Werte werden
              schreibgeschützt angezeigt.
            </Callout>
          ) : null}

          <form id="ai-settings-form" className="form-narrow" action={saveAiSettings}>
            <input type="hidden" name="org" value={orgId} />

            <Section
              title="Eskalations-Keywords"
              help={
                <>
                  Fällt eines dieser Wörter, wird immer eskaliert — als Übergabe an einen Menschen
                  oder als Ticket, je nach Einstellung des{' '}
                  <Link href={href('/settings/agents', { org: orgId })}>Agenten</Link>. Gilt für Text
                  und Telefon.
                </>
              }
            >
              <Field label="Keywords" htmlFor="escalation_keywords" help="Kommagetrennte Liste.">
                <input
                  id="escalation_keywords"
                  name="escalation_keywords"
                  type="text"
                  defaultValue={keywords.join(', ')}
                  disabled={disabled}
                  placeholder="kündigung, beschwerde, anwalt, datenschutz"
                />
              </Field>
            </Section>

            <Section
              title="Geschäftszeiten"
              help="Bestimmen, welcher Bestätigungstext verwendet wird. Ausgeschaltete Tage gelten als geschlossen."
            >
              <div className="field--short">
                <Field label="Zeitzone (IANA)" htmlFor="timezone">
                  <input
                    id="timezone"
                    name="timezone"
                    type="text"
                    defaultValue={businessHours.timezone}
                    disabled={disabled}
                    placeholder="Europe/Berlin"
                  />
                </Field>
              </div>
              <div className="hours">
                {WEEKDAYS.map((day) => {
                  const slot = businessHours.hours[day];
                  return (
                    <div key={day} className="hours-row">
                      <input
                        id={`bh_${day}_enabled`}
                        type="checkbox"
                        className="switch"
                        name={`bh_${day}_enabled`}
                        defaultChecked={Boolean(slot)}
                        disabled={disabled}
                      />
                      <label htmlFor={`bh_${day}_enabled`} className="hours-day">
                        {weekdayLabels[day]}
                      </label>
                      <span className="hours-times">
                        <input
                          type="time"
                          name={`bh_${day}_open`}
                          defaultValue={slot?.open ?? '09:00'}
                          disabled={disabled}
                          aria-label={`${weekdayLabels[day]} Öffnung`}
                        />
                        bis
                        <input
                          type="time"
                          name={`bh_${day}_close`}
                          defaultValue={slot?.close ?? '17:00'}
                          disabled={disabled}
                          aria-label={`${weekdayLabels[day]} Schließung`}
                        />
                      </span>
                      <span className="hours-closed">Geschlossen</span>
                    </div>
                  );
                })}
              </div>
            </Section>

            <Section
              title="Bestätigung bei Übergabe"
              help="Kurze Nachricht an den Kunden, sobald an einen Menschen übergeben wird — je nach Geschäftszeiten ein anderer Text."
            >
              <SettingRow label="Automatische Eingangsbestätigung senden" htmlFor="ack_enabled">
                <input
                  id="ack_enabled"
                  type="checkbox"
                  className="switch"
                  name="ack_enabled"
                  defaultChecked={autoAck.enabled}
                  disabled={disabled}
                />
              </SettingRow>
              <Field label="Text innerhalb der Geschäftszeiten" htmlFor="ack_in_hours">
                <textarea
                  id="ack_in_hours"
                  name="ack_in_hours"
                  rows={3}
                  defaultValue={autoAck.in_hours}
                  disabled={disabled}
                />
              </Field>
              <Field label="Text außerhalb der Geschäftszeiten" htmlFor="ack_out_of_hours">
                <textarea
                  id="ack_out_of_hours"
                  name="ack_out_of_hours"
                  rows={3}
                  defaultValue={autoAck.out_of_hours}
                  disabled={disabled}
                />
              </Field>
            </Section>

            <Section
              title="Ticket-Bestätigung"
              help={
                <>
                  Wird gesendet, wenn ein Agent mit „Als Ticket aufnehmen“ ein neues Ticket anlegt
                  (Text-Kanäle; am Telefon wird keine Nummer genannt). Der Platzhalter{' '}
                  <code>{'{ticket_id}'}</code> steht für die Ticketnummer, leere Felder verwenden
                  den Standardtext.
                </>
              }
            >
              <SettingRow label="Ticket-Bestätigung senden" htmlFor="ticket_ack_enabled">
                <input
                  id="ticket_ack_enabled"
                  type="checkbox"
                  className="switch"
                  name="ticket_ack_enabled"
                  defaultChecked={ticketAck.enabled}
                  disabled={disabled}
                />
              </SettingRow>
              <Field label="Text innerhalb der Geschäftszeiten" htmlFor="ticket_ack_in_hours">
                <textarea
                  id="ticket_ack_in_hours"
                  name="ticket_ack_in_hours"
                  rows={3}
                  maxLength={1000}
                  defaultValue={ticketAck.in_hours}
                  placeholder={DEFAULT_TICKET_ACK_TEXT}
                  disabled={disabled}
                />
              </Field>
              <Field label="Text außerhalb der Geschäftszeiten" htmlFor="ticket_ack_out_of_hours">
                <textarea
                  id="ticket_ack_out_of_hours"
                  name="ticket_ack_out_of_hours"
                  rows={3}
                  maxLength={1000}
                  defaultValue={ticketAck.out_of_hours}
                  placeholder={DEFAULT_TICKET_ACK_TEXT}
                  disabled={disabled}
                />
              </Field>
            </Section>

            <Section title="Erinnerung bei wartender Übergabe">
              <SettingRow
                label="Erinnerung nach"
                help="Interne Notiz an der Konversation, wenn so lange kein Mitarbeiter reagiert hat. Nur innerhalb der Geschäftszeiten; nachts aufgelaufene Übergaben erinnern kurz nach Öffnung. Leer lassen schaltet sie aus."
                htmlFor="handoff_sla_minutes"
              >
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
                Minuten
              </SettingRow>
            </Section>
          </form>
        </div>

        {isOwner ? (
          <div className="save-bar">
            <Button type="submit" form="ai-settings-form" variant="primary">
              Einstellungen speichern
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsFrame>
  );
}
