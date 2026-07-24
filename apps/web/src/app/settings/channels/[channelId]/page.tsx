// Channel DETAIL page (two-level layout, owner 2026-07-24): everything about
// ONE channel — status toggle, agent assignment and the flavor-specific
// settings (voice tuning, widget theme + embed, WhatsApp split, intake
// address). Actions return here via the validated returnTo field.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { canViewArea, isAdminRole, type Channel } from '@zendori/core';
import { businessHoursSchema, hasConfiguredHours, type BusinessHours } from '@zendori/channels';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { appUrl } from '@/lib/env';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import VoicePicker from '@/components/VoicePicker';
import GreetingSuggestion from '@/components/GreetingSuggestion';
import {
  deleteChannel,
  updateConversationSplit,
  updateVoiceChannelSettings,
  updateWidgetTheme,
} from '../actions';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import {
  ActiveToggle,
  AgentSelect,
  FLAVOR_LABELS,
  VOICE_LANGUAGES,
  channelFlavor,
  channelIdentifier,
  listAgentOptions,
  toIntakeChannelView,
  toVoiceChannelView,
  toWhatsappChannelView,
  toWidgetChannelView,
} from '../shared';

const SPLIT_PRESETS = [24, 72, 168];

export default async function ChannelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ channelId: string }>;
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { channelId } = await params;
  const { org, error, notice } = await searchParams;
  const { orgId, orgs, role, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'channels')) return <NoAccessPanel title="Kanäle" />;
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const isOwner = isAdminRole(role);
  const returnTo = `/settings/channels/${channelId}`;

  const supabase = await createSupabaseServerClient();
  const [{ data: channelData }, agentOptions, hoursRow] = await Promise.all([
    supabase.from('channels').select('*').eq('org_id', orgId).eq('id', channelId).maybeSingle(),
    listAgentOptions(orgId),
    supabase.from('org_settings').select('business_hours').eq('org_id', orgId).maybeSingle(),
  ]);
  if (!channelData) notFound();
  const channel = channelData as unknown as Channel;
  const flavor = channelFlavor(channel);

  const { count: conversationCount } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('channel_id', channelId);

  let businessHours: BusinessHours | null = null;
  const rawHours = (hoursRow.data as { business_hours: unknown } | null)?.business_hours;
  if (rawHours != null) {
    const parsedHours = businessHoursSchema.safeParse(rawHours);
    businessHours = parsedHours.success ? parsedHours.data : null;
  }
  const hoursConfigured = hasConfiguredHours(businessHours);

  const base = appUrl().replace(/\/+$/, '');

  const conversationSplitForm = (current: number | null): ReactNode => (
    <form action={updateConversationSplit}>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="channelId" value={channel.id} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <label htmlFor="split-hours" className="field-label" style={{ marginBottom: 0 }}>
        Neue Unterhaltung nach Inaktivität
      </label>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.3rem' }}>
        <select
          id="split-hours"
          name="splitHours"
          defaultValue={current === null ? '' : String(current)}
          disabled={!isOwner}
          style={{ maxWidth: '18rem' }}
        >
          <option value="">Aus — nie trennen</option>
          <option value="24">Nach 24 Stunden</option>
          <option value="72">Nach 3 Tagen</option>
          <option value="168">Nach 7 Tagen</option>
          {current !== null && !SPLIT_PRESETS.includes(current) ? (
            <option value={String(current)}>Nach {current} Stunden</option>
          ) : null}
        </select>
        <button className="ghost" type="submit" disabled={!isOwner}>
          Speichern
        </button>
      </div>
      <p className="hint">
        Schreibt der Kontakt nach dieser Zeit erneut, beginnt ein neues Ticket. Unterhaltungen, die
        gerade auf euch warten, werden nie getrennt.
      </p>
    </form>
  );

  // --- flavor-specific settings ------------------------------------------------

  const sections: ReactNode[] = [];

  if (flavor === 'form' || flavor === 'email') {
    const intake = toIntakeChannelView(channel);
    sections.push(
      <div className="panel" key="intake">
        <h2>{flavor === 'form' ? 'Intake-Adresse' : 'Weiterleitungs-Adresse'}</h2>
        <code className="invite-link">{intake?.address}</code>
        <p className="hint" style={{ marginTop: '0.5rem' }}>
          {flavor === 'form'
            ? 'Diese Adresse als Empfänger (oder CC) im Kontaktformular der Website eintragen. Der echte Absender wird aus dem Formular-Inhalt extrahiert.'
            : 'Im bestehenden Postfach eine Weiterleitung auf diese Adresse einrichten. Der echte Absender wird aus dem Weiterleitungs-Header übernommen.'}
        </p>
      </div>
    );
  }

  if (flavor === 'whatsapp') {
    const wa = toWhatsappChannelView(channel);
    sections.push(
      <div className="panel" key="wa">
        <h2>WhatsApp-Einstellungen</h2>
        <div style={{ marginBottom: '1rem' }}>
          <span className="field-label">Webhook-URL (in Twilio eintragen)</span>
          <code className="invite-link">{`${base}/api/hooks/whatsapp/twilio`}</code>
        </div>
        {conversationSplitForm(wa?.splitHours ?? null)}
      </div>
    );
  }

  if (flavor === 'chat') {
    const widget = toWidgetChannelView(channel);
    if (widget) {
      sections.push(
        <div className="panel" key="widget">
          <h2>Widget-Einstellungen</h2>
          <form className="stack" action={updateWidgetTheme} style={{ maxWidth: '26rem' }}>
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="channelId" value={widget.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <div>
              <label htmlFor="widget-color">Farbe</label>
              <input id="widget-color" name="color" type="color" defaultValue={widget.theme.color} />
            </div>
            <div>
              <label htmlFor="widget-title">Titel</label>
              <input
                id="widget-title"
                name="title"
                type="text"
                required
                minLength={1}
                maxLength={60}
                defaultValue={widget.theme.title}
              />
            </div>
            <div>
              <label htmlFor="widget-greeting">Begrüßung</label>
              <textarea
                id="widget-greeting"
                name="greeting"
                rows={3}
                required
                maxLength={300}
                defaultValue={widget.theme.greeting}
              />
            </div>
            {isOwner ? (
              <button className="primary" type="submit">
                Theme speichern
              </button>
            ) : null}
          </form>
          <div style={{ marginTop: '1.25rem' }}>
            <span className="field-label">Embed-Code</span>
            <code className="invite-link">
              {`<script src="${base}/widget.js" data-zendori-token="${widget.publicToken}" async></script>`}
            </code>
            <p className="hint">
              Diesen Code auf der Website vor dem schließenden &lt;/body&gt;-Tag einfügen. Der
              Token ist öffentlich — er identifiziert nur den Kanal und enthält keine Geheimnisse.
            </p>
          </div>
          <div style={{ marginTop: '1.25rem' }}>{conversationSplitForm(widget.splitHours)}</div>
        </div>
      );
    }
  }

  if (flavor === 'voice') {
    const vc = toVoiceChannelView(channel);
    if (vc) {
      const assignedAgent = agentOptions.find((a) => a.id === vc.agentId) ?? null;
      const greetingAgentMode: 'answer' | 'intake' | null = assignedAgent
        ? assignedAgent.mode === 'autopilot'
          ? 'answer'
          : 'intake'
        : null;
      sections.push(
        <div className="panel" key="voice">
          <h2>Voice-Einstellungen</h2>
          {/* 0018: honest transfer status at a glance */}
          <p className="hint" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
            <span className={vc.transferNumber ? 'badge badge--success' : 'badge badge--warn'}>
              {vc.transferNumber ? 'Live-Weiterleitung aktiv' : 'Nur Rückruf-Ticket'}
            </span>
            <span>
              {vc.transferNumber
                ? hoursConfigured
                  ? `An ${vc.transferNumber} innerhalb der Geschäftszeiten — außerhalb: Rückruf-Ticket.`
                  : `An ${vc.transferNumber}, jederzeit — keine Geschäftszeiten gepflegt.`
                : 'Ohne Transfer-Nummer werden Übergaben als Rückruf-Ticket aufgenommen.'}
            </span>
          </p>
          <form className="stack" action={updateVoiceChannelSettings} style={{ maxWidth: '30rem' }}>
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="channelId" value={vc.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            {/* the action is owner-gated — read-only for members instead of a
                data-losing rejection on submit */}
            <fieldset disabled={!isOwner} style={{ border: 'none', padding: 0, margin: 0, display: 'contents' }}>
              <div>
                <label htmlFor="voice-greeting">Begrüßung (Welcome Message)</label>
                <input
                  id="voice-greeting"
                  name="greeting"
                  type="text"
                  maxLength={500}
                  defaultValue={vc.greeting}
                  placeholder="Leer = der Agent begrüßt frei"
                />
                <GreetingSuggestion
                  inputId="voice-greeting"
                  companyName={orgName}
                  agentMode={greetingAgentMode}
                />
                <label htmlFor="voice-greeting-int" className="check-row" style={{ marginTop: '0.5rem' }}>
                  <input
                    id="voice-greeting-int"
                    name="greetingInterruptible"
                    type="checkbox"
                    defaultChecked={vc.greetingInterruptible}
                  />
                  Anrufer darf die Begrüßung unterbrechen
                </label>
                <p className="hint">
                  Standard: aus — die Begrüßung wird immer vollständig gesprochen, auch wenn der
                  Anrufer hineinredet.
                </p>
              </div>
              <div>
                <label htmlFor="voice-voice">Stimme</label>
                <VoicePicker id="voice-voice" name="voice" defaultVoice={vc.voice} />
              </div>
              <div>
                <label htmlFor="voice-language">Sprache des Voice-Agents</label>
                <select id="voice-language" name="languageHint" defaultValue={vc.languageHint}>
                  {VOICE_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
                <p className="hint">
                  Gesprächs- und Erkennungssprache. Spricht der Anrufer eine andere Sprache,
                  wechselt der Assistent automatisch.
                </p>
              </div>
              <div>
                <label htmlFor="voice-keyterms">
                  Fachbegriffe (kommagetrennt, verbessern die Erkennung)
                </label>
                <input
                  id="voice-keyterms"
                  name="keyterms"
                  type="text"
                  maxLength={4000}
                  defaultValue={vc.keyterms}
                  placeholder="z. B. Produktnamen, Markennamen"
                />
              </div>
              <div>
                <label htmlFor="voice-speed">Sprechtempo (0,7–1,5)</label>
                <input
                  id="voice-speed"
                  name="speechSpeed"
                  type="number"
                  step="0.05"
                  min="0.7"
                  max="1.5"
                  defaultValue={vc.speechSpeed}
                />
              </div>
              <div>
                <label htmlFor="voice-transfer">
                  Transfer-Nummer (optional, für Live-Weiterleitung an einen Menschen)
                </label>
                <input
                  id="voice-transfer"
                  name="transferNumber"
                  type="text"
                  defaultValue={vc.transferNumber}
                  placeholder="+49301234567 (leer = Rückruf-Ticket)"
                />
              </div>
              <div>
                <label htmlFor="voice-recording" className="check-row">
                  <input
                    id="voice-recording"
                    name="recordingEnabled"
                    type="checkbox"
                    defaultChecked={vc.recordingEnabled}
                  />
                  Anrufe aufzeichnen
                </label>
                <p className="hint">
                  Der Assistent spricht zu Gesprächsbeginn einen Aufzeichnungshinweis (gesetzlich
                  erforderlich, § 201 StGB). Die Aufnahme erscheint nach dem Anruf als Anhang in
                  der Konversation und wird in der EU gespeichert.
                </p>
              </div>
              {isOwner ? (
                <button className="primary" type="submit">
                  Voice-Einstellungen speichern
                </button>
              ) : (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  Nur Inhaber können die Voice-Einstellungen ändern.
                </p>
              )}
            </fieldset>
          </form>
        </div>
      );
    }
  }

  if (flavor === 'webform') {
    // builder-form id for the "Im Builder bearbeiten" link
    const { data: formRow } = await supabase
      .from('forms')
      .select('id')
      .eq('org_id', orgId)
      .eq('channel_id', channel.id)
      .maybeSingle();
    const formId = (formRow as { id?: string } | null)?.id;
    sections.push(
      <div className="panel" key="webform">
        <h2>Web-Formular</h2>
        <p className="help">
          Design, Felder, Einbetten-Code und Weiterleitungs-Empfänger bearbeitest du im
          Formular-Builder.
        </p>
        <Link
          className="primary"
          style={{ display: 'inline-block', textDecoration: 'none', padding: '0.5rem 1.2rem', borderRadius: '9999px' }}
          href={formId ? `/settings/forms/${formId}?org=${orgId}` : `/settings/forms?org=${orgId}`}
        >
          Im Builder bearbeiten
        </Link>
      </div>
    );
  }

  if (flavor === 'test') {
    sections.push(
      <div className="panel" key="test">
        <h2>Test-Channel</h2>
        <p className="help">
          Nachrichten manuell einspeisen — zum Ausprobieren von Inbox, KI und Zuweisung:{' '}
          <Link href={`/test-channel?org=${orgId}`}>zum Test-Channel</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="page-head">
        <h1>{channel.name}</h1>
        <p>
          <Link href={`/settings/channels?org=${orgId}`}>← Alle Kanäle</Link>
          <span style={{ color: 'var(--text-muted)' }}> · {FLAVOR_LABELS[flavor]}</span>
        </p>
      </div>

      <DismissibleBanners error={error} notice={notice} style={{ marginBottom: '1.5rem' }} />

      <div className="panel">
        <div className="chan-instance chan-instance--header">
          <div style={{ minWidth: 0, flex: 1 }}>
            <span className="field-label">{FLAVOR_LABELS[flavor]}</span>
            <code className="invite-link">{channelIdentifier(channel)}</code>
            <AgentSelect
              orgId={orgId}
              channelId={channel.id}
              channelType={channel.type}
              agentId={channel.agent_id ?? null}
              agents={agentOptions}
              disabled={!isOwner}
              returnTo={returnTo}
            />
            <p className="hint">
              Ohne zugewiesenen Agenten werden Nachrichten nur in der Inbox gesammelt — keine
              KI-Antworten.
            </p>
          </div>
          <ActiveToggle
            orgId={orgId}
            channelId={channel.id}
            isActive={channel.is_active}
            returnTo={returnTo}
          />
        </div>
      </div>

      {sections}

      {isOwner && flavor !== 'webform' ? (
        <div className="panel">
          <h2>Kanal löschen</h2>
          <p className="help">
            Löscht den Kanal <strong>unwiderruflich</strong> — inklusive{' '}
            {conversationCount === 1
              ? 'der 1 zugehörigen Konversation'
              : `aller ${conversationCount ?? 0} zugehörigen Konversationen`}{' '}
            samt Nachrichten und Notizen.
          </p>
          <form action={deleteChannel}>
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="channelId" value={channel.id} />
            <ConfirmDeleteButton label="Kanal löschen" confirmLabel="Endgültig löschen" />
          </form>
        </div>
      ) : null}
      {isOwner && flavor === 'webform' ? (
        <div className="panel">
          <h2>Kanal löschen</h2>
          <p className="help">
            Web-Formulare löschst du im Formular-Builder (mit Namens-Bestätigung) — dort wird das
            Formular samt Kanal entfernt.
          </p>
        </div>
      ) : null}
    </div>
  );
}
