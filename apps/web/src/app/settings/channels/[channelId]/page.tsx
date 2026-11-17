// Channel DETAIL page (redesign, page type C — docs/design-redesign.md §5/§7):
// everything about ONE channel in sections — agent + status, name and the
// flavor-specific settings (voice tuning, widget theme + embed, WhatsApp
// webhook, intake address). Chat and voice channels have more than three
// sections and therefore page tabs (?tab=…). Actions return here via the
// validated returnTo field (plus the tab the form was on).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { canViewArea, isAdminRole, type Channel } from '@zendori/core';
import { businessHoursSchema, hasConfiguredHours, type BusinessHours } from '@zendori/channels';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { appUrl } from '@/lib/env';
import { href } from '@/lib/href';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import VoicePicker from '@/components/VoicePicker';
import GreetingSuggestion from '@/components/GreetingSuggestion';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { Field, SettingRow } from '@/components/ui/Field';
import { CodeBlock, Section, Tabs } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import {
  deleteChannel,
  updateConversationSplit,
  renameChannel,
  updateVoiceChannelSettings,
  updateWidgetTheme,
} from '../actions';
import {
  ActiveToggle,
  AgentSelect,
  FLAVOR_LABELS,
  FLAVOR_ROUTING_HINT,
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

/** ids of the two long forms; their submit button sits in the save bar below. */
const VOICE_FORM_ID = 'voice-settings';
const THEME_FORM_ID = 'widget-theme';

type TabKey = 'general' | 'design' | 'embed' | 'voice';
const CHAT_TABS: { key: TabKey; label: string }[] = [
  { key: 'general', label: 'Allgemein' },
  { key: 'design', label: 'Design' },
  { key: 'embed', label: 'Einbetten' },
];
const VOICE_TABS: { key: TabKey; label: string }[] = [
  { key: 'general', label: 'Allgemein' },
  { key: 'voice', label: 'Sprachassistent' },
];

export default async function ChannelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ channelId: string }>;
  searchParams: Promise<{ org?: string; error?: string; notice?: string; tab?: string }>;
}) {
  const { channelId } = await params;
  const { org, error, notice, tab } = await searchParams;
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
  const widget = flavor === 'chat' ? toWidgetChannelView(channel) : null;
  const vc = flavor === 'voice' ? toVoiceChannelView(channel) : null;

  // Page tabs only where there are more than three sections (chat, voice).
  const tabs = widget ? CHAT_TABS : vc ? VOICE_TABS : null;
  const activeTab: TabKey = tabs?.find((t) => t.key === tab)?.key ?? 'general';

  /** Hidden fields of every form on this page: where to return to, on which tab. */
  const formBase = (
    <>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="channelId" value={channel.id} />
      <input type="hidden" name="returnTo" value={returnTo} />
      {activeTab === 'general' ? null : <input type="hidden" name="tab" value={activeTab} />}
    </>
  );

  const conversationSplitSection = (current: number | null): ReactNode => (
    <Section title="Unterhaltungen">
      <form action={updateConversationSplit}>
        {formBase}
        <SettingRow
          label="Neue Unterhaltung nach Inaktivität"
          help="Schreibt der Kontakt nach dieser Zeit erneut, beginnt ein neues Ticket. Unterhaltungen, die gerade auf euch warten, werden nie getrennt."
          htmlFor="split-hours"
        >
          <select
            id="split-hours"
            name="splitHours"
            defaultValue={current === null ? '' : String(current)}
            disabled={!isOwner}
          >
            <option value="">Aus — nie trennen</option>
            <option value="24">Nach 24 Stunden</option>
            <option value="72">Nach 3 Tagen</option>
            <option value="168">Nach 7 Tagen</option>
            {current !== null && !SPLIT_PRESETS.includes(current) ? (
              <option value={String(current)}>Nach {current} Stunden</option>
            ) : null}
          </select>
          <Button type="submit" disabled={!isOwner}>
            Speichern
          </Button>
        </SettingRow>
      </form>
    </Section>
  );

  // --- tab "Allgemein" (the whole page for channels without tabs) --------------

  let flavorSections: ReactNode = null;

  if (flavor === 'form' || flavor === 'email') {
    const intake = toIntakeChannelView(channel);
    flavorSections = (
      <Section
        title={flavor === 'form' ? 'Intake-Adresse' : 'Weiterleitungs-Adresse'}
        help={
          flavor === 'form'
            ? 'Diese Adresse als Empfänger (oder CC) im Kontaktformular der Website eintragen. Der echte Absender wird aus dem Formular-Inhalt gelesen.'
            : 'Im bestehenden Postfach eine Weiterleitung auf diese Adresse einrichten. Der echte Absender wird aus dem Weiterleitungs-Header übernommen.'
        }
      >
        <CodeBlock>{intake?.address}</CodeBlock>
      </Section>
    );
  } else if (flavor === 'whatsapp') {
    const wa = toWhatsappChannelView(channel);
    flavorSections = (
      <>
        <Section
          title="Webhook-URL"
          help="In der Twilio-Console bei der Nummer unter „A message comes in“ (POST) eintragen."
        >
          <CodeBlock>{`${base}/api/hooks/whatsapp/twilio`}</CodeBlock>
        </Section>
        {conversationSplitSection(wa?.splitHours ?? null)}
      </>
    );
  } else if (widget) {
    flavorSections = conversationSplitSection(widget.splitHours);
  } else if (flavor === 'webform') {
    // builder-form id for the "Im Builder bearbeiten" link
    const { data: formRow } = await supabase
      .from('forms')
      .select('id')
      .eq('org_id', orgId)
      .eq('channel_id', channel.id)
      .maybeSingle();
    const formId = (formRow as { id?: string } | null)?.id;
    flavorSections = (
      <Section
        title="Web-Formular"
        help="Design, Felder, Einbetten-Code und Weiterleitungs-Empfänger bearbeitest du im Formular-Builder. Dort löschst du das Formular auch, samt diesem Kanal."
      >
        <div>
          <Button
            href={href(formId ? `/settings/forms/${formId}` : '/settings/forms', { org: orgId })}
            variant="primary"
          >
            Im Builder bearbeiten
          </Button>
        </div>
      </Section>
    );
  } else if (flavor === 'test') {
    flavorSections = (
      <Section
        title="Test-Channel"
        help="Nachrichten manuell einspeisen, um Inbox, KI und Zuweisung auszuprobieren."
      >
        <div>
          <Button href={href('/test-channel', { org: orgId })}>Zum Test-Channel</Button>
        </div>
      </Section>
    );
  }

  const generalTab = (
    <>
      <Section title="Agent und Status">
        <div>
          <SettingRow
            label="Agent"
            help="Ohne zugewiesenen Agenten werden Nachrichten nur in der Inbox gesammelt, es gibt keine KI-Antworten."
            htmlFor="channel-agent"
          >
            <AgentSelect
              orgId={orgId}
              channelId={channel.id}
              channelType={channel.type}
              agentId={channel.agent_id ?? null}
              agents={agentOptions}
              disabled={!isOwner}
              returnTo={returnTo}
              selectId="channel-agent"
            />
          </SettingRow>
          <SettingRow label="Kanal aktiv">
            <ActiveToggle
              orgId={orgId}
              channelId={channel.id}
              isActive={channel.is_active}
              returnTo={returnTo}
            />
          </SettingRow>
        </div>
      </Section>

      <Section
        title="Name"
        help={`Nur eine Bezeichnung für dich. Die Zustellung läuft weiter über ${FLAVOR_ROUTING_HINT[flavor]}.`}
      >
        <form action={renameChannel}>
          {formBase}
          <Field label="Kanalname" htmlFor="channel-name">
            <div className="row">
              <input
                id="channel-name"
                className="grow"
                type="text"
                name="name"
                defaultValue={channel.name}
                required
                minLength={2}
                maxLength={120}
              />
              <Button type="submit">Namen speichern</Button>
            </div>
          </Field>
        </form>
      </Section>

      {flavorSections}
    </>
  );

  // --- tab "Design" / "Einbetten" (chat) ---------------------------------------

  const designTab = widget ? (
    <Section title="Widget-Design" help="So erscheint der Chat auf deiner Website.">
      <form id={THEME_FORM_ID} className="stack" action={updateWidgetTheme}>
        {formBase}
        <Field label="Farbe" htmlFor="widget-color">
          <input id="widget-color" name="color" type="color" defaultValue={widget.theme.color} />
        </Field>
        <Field label="Titel" htmlFor="widget-title">
          <input
            id="widget-title"
            name="title"
            type="text"
            required
            minLength={1}
            maxLength={60}
            defaultValue={widget.theme.title}
          />
        </Field>
        <Field label="Begrüßung" htmlFor="widget-greeting">
          <textarea
            id="widget-greeting"
            name="greeting"
            rows={3}
            required
            maxLength={300}
            defaultValue={widget.theme.greeting}
          />
        </Field>
      </form>
    </Section>
  ) : null;

  const embedTab = widget ? (
    <Section
      title="Embed-Code"
      help="Auf der Website vor dem schließenden </body>-Tag einfügen. Der Token ist öffentlich: Er identifiziert nur den Kanal und enthält keine Geheimnisse."
    >
      <CodeBlock>
        {`<script src="${base}/widget.js" data-zendori-token="${widget.publicToken}" async></script>`}
      </CodeBlock>
      {/* former sidebar entry "Widget-Demo" */}
      <p className="muted small">
        Ausprobieren:{' '}
        <Link href={href('/widget-demo', { org: orgId })}>Widget-Demo öffnen</Link>
      </p>
    </Section>
  ) : null;

  // --- tab "Sprachassistent" (voice) -------------------------------------------

  let voiceTab: ReactNode = null;
  if (vc) {
    const assignedAgent = agentOptions.find((a) => a.id === vc.agentId) ?? null;
    const greetingAgentMode: 'answer' | 'intake' | null = assignedAgent
      ? assignedAgent.mode === 'autopilot'
        ? 'answer'
        : 'intake'
      : null;
    voiceTab = (
      <form id={VOICE_FORM_ID} action={updateVoiceChannelSettings}>
        {formBase}
        {/* the action is owner-gated — read-only for members instead of a
            data-losing rejection on submit */}
        <fieldset disabled={!isOwner} className="fieldset-plain fieldset-plain--contents">
          <Section title="Ansagen">
            <div className="stack">
              <Field label="Begrüßung" htmlFor="voice-greeting">
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
              </Field>
              <SettingRow
                label="Anrufer darf die Begrüßung unterbrechen"
                help="Standard: aus. Dann wird die Begrüßung immer vollständig gesprochen, auch wenn der Anrufer hineinredet."
                htmlFor="voice-greeting-int"
              >
                <input
                  id="voice-greeting-int"
                  name="greetingInterruptible"
                  type="checkbox"
                  className="switch"
                  defaultChecked={vc.greetingInterruptible}
                />
              </SettingRow>
              <Field
                label="Verabschiedung"
                htmlFor="voice-farewell"
                help="Der Assistent spricht diesen Satz garantiert, bevor aufgelegt wird. Kein Anruf endet abrupt."
              >
                <input
                  id="voice-farewell"
                  name="farewell"
                  type="text"
                  maxLength={500}
                  defaultValue={vc.farewell}
                  placeholder="Leer = „Vielen Dank für Ihren Anruf. Auf Wiederhören!“"
                />
              </Field>
            </div>
          </Section>

          <Section title="Stimme und Sprache">
            <div className="stack">
              <Field label="Stimme" htmlFor="voice-voice">
                <VoicePicker id="voice-voice" name="voice" defaultVoice={vc.voice} />
              </Field>
              <Field
                label="Sprache des Voice-Agents"
                htmlFor="voice-language"
                help="Gesprächs- und Erkennungssprache. Spricht der Anrufer eine andere Sprache, wechselt der Assistent automatisch."
              >
                <select id="voice-language" name="languageHint" defaultValue={vc.languageHint}>
                  {VOICE_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Fachbegriffe"
                htmlFor="voice-keyterms"
                help="Kommagetrennt. Sie verbessern die Erkennung."
              >
                <input
                  id="voice-keyterms"
                  name="keyterms"
                  type="text"
                  maxLength={4000}
                  defaultValue={vc.keyterms}
                  placeholder="z. B. Produktnamen, Markennamen"
                />
              </Field>
              <Field label="Sprechtempo (0,7–1,5)" htmlFor="voice-speed">
                <input
                  id="voice-speed"
                  name="speechSpeed"
                  type="number"
                  step="0.05"
                  min="0.7"
                  max="1.5"
                  defaultValue={vc.speechSpeed}
                />
              </Field>
            </div>
          </Section>

          <Section title="Weiterleitung an einen Menschen">
            {/* 0018: honest transfer status at a glance */}
            <div className="row">
              <Badge tone={vc.transferNumber ? 'success' : 'warn'}>
                {vc.transferNumber ? 'Live-Weiterleitung aktiv' : 'Nur Rückruf-Ticket'}
              </Badge>
              <span className="muted small">
                {vc.transferNumber
                  ? hoursConfigured
                    ? `An ${vc.transferNumber} innerhalb der Geschäftszeiten — außerhalb: Rückruf-Ticket.`
                    : `An ${vc.transferNumber}, jederzeit — keine Geschäftszeiten gepflegt.`
                  : 'Ohne Transfer-Nummer werden Übergaben als Rückruf-Ticket aufgenommen.'}
              </span>
            </div>
            <Field
              label="Transfer-Nummer"
              htmlFor="voice-transfer"
              help="Optional. Leer lassen: Übergaben werden als Rückruf-Ticket aufgenommen."
            >
              <input
                id="voice-transfer"
                name="transferNumber"
                type="text"
                defaultValue={vc.transferNumber}
                placeholder="+49301234567"
              />
            </Field>
          </Section>

          <Section title="Aufzeichnung">
            <SettingRow
              label="Anrufe aufzeichnen"
              help="Der Assistent spricht zu Gesprächsbeginn einen Aufzeichnungshinweis (gesetzlich erforderlich, § 201 StGB). Die Aufnahme erscheint nach dem Anruf als Anhang in der Konversation und wird in der EU gespeichert."
              htmlFor="voice-recording"
            >
              <input
                id="voice-recording"
                name="recordingEnabled"
                type="checkbox"
                className="switch"
                defaultChecked={vc.recordingEnabled}
              />
            </SettingRow>
          </Section>
        </fieldset>
      </form>
    );
  }

  // --- save bar of the two long forms (their button lives outside the form) ----

  let saveBar: ReactNode = null;
  if (activeTab === 'voice') {
    saveBar = isOwner ? (
      <Button type="submit" form={VOICE_FORM_ID} variant="primary">
        Voice-Einstellungen speichern
      </Button>
    ) : (
      <span className="muted small">Nur Inhaber können die Voice-Einstellungen ändern.</span>
    );
  } else if (activeTab === 'design' && isOwner) {
    saveBar = (
      <Button type="submit" form={THEME_FORM_ID} variant="primary">
        Theme speichern
      </Button>
    );
  }

  const identifier = channelIdentifier(channel);
  // only real routing identifiers are worth showing next to the type
  const showIdentifier = ['form', 'email', 'whatsapp', 'voice'].includes(flavor);
  const conversationsText =
    conversationCount === 1
      ? 'der 1 zugehörigen Konversation'
      : `aller ${conversationCount ?? 0} zugehörigen Konversationen`;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[
          { label: 'Kanäle', href: href('/settings/channels', { org: orgId }) },
          { label: channel.name },
        ]}
        title={channel.name}
        badges={
          channel.is_active ? (
            <Badge tone="success" dot>
              Aktiv
            </Badge>
          ) : (
            <Badge tone="muted" dot>
              Inaktiv
            </Badge>
          )
        }
        subtitle={
          showIdentifier ? (
            <>
              {FLAVOR_LABELS[flavor]} · <span className="mono">{identifier}</span>
            </>
          ) : (
            FLAVOR_LABELS[flavor]
          )
        }
        actions={
          // Web-Formular channels are deleted in the form builder (name confirmation there)
          isOwner && flavor !== 'webform' ? (
            <Menu>
              <p className="menu-note">
                Löschen ist unwiderruflich und entfernt den Kanal samt {conversationsText},
                Nachrichten und Notizen.
              </p>
              <form action={deleteChannel}>
                <input type="hidden" name="org" value={orgId} />
                <input type="hidden" name="channelId" value={channel.id} />
                <ConfirmDeleteButton
                  inMenu
                  label="Kanal löschen"
                  confirmLabel="Endgültig löschen"
                />
              </form>
            </Menu>
          ) : null
        }
        tabs={
          tabs ? (
            <Tabs
              label="Bereiche des Kanals"
              items={tabs.map((t) => ({
                label: t.label,
                href: href(returnTo, { org: orgId, tab: t.key === 'general' ? undefined : t.key }),
                active: t.key === activeTab,
              }))}
            />
          ) : undefined
        }
      />

      <div className="page-body">
        <DismissibleBanners error={error} notice={notice} />
        <div className="form-narrow">
          {activeTab === 'design'
            ? designTab
            : activeTab === 'embed'
              ? embedTab
              : activeTab === 'voice'
                ? voiceTab
                : generalTab}
        </div>
      </div>

      {saveBar ? <div className="save-bar">{saveBar}</div> : null}
    </div>
  );
}
