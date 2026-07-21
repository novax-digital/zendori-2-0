import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import type { AgentKind, AgentMode, Channel, ChannelKind } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { listChannels } from '@/lib/inbox/queries';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createTestChannel } from '@/app/inbox/actions';
import {
  createWidgetChannel,
  updateWidgetTheme,
  updateConversationSplit,
  createIntakeAddress,
  createWhatsappTwilioChannel,
  updateVoiceChannelSettings,
  setChannelActive,
  setChannelAgent,
} from './actions';
import ChannelGallery, { type TileKey, type TileMeta } from '@/components/ChannelGallery';
import VoicePicker from '@/components/VoicePicker';
import GreetingSuggestion from '@/components/GreetingSuggestion';
import { DEFAULT_THEME, type WidgetTheme } from '@/lib/widget/session';
import { appUrl } from '@/lib/env';
import { countChannelsByKind, loadChannelLimits } from '@/lib/channel-limits';
import { businessHoursSchema, hasConfiguredHours, type BusinessHours } from '@zendori/channels';

type AgentOption = { id: string; name: string; is_active: boolean; kind: AgentKind; mode: AgentMode };

async function listAgentOptions(orgId: string): Promise<AgentOption[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('agents')
    .select('id, name, is_active, kind, mode')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  return (data ?? []) as AgentOption[];
}


type WidgetChannelView = {
  id: string;
  name: string;
  publicToken: string;
  theme: WidgetTheme;
  splitHours: number | null;
  isActive: boolean;
  agentId: string | null;
};

/** Extracts the widget config from a channel row; returns null for non-widget channels. */
function toWidgetChannelView(channel: Channel): WidgetChannelView | null {
  const config = channel.config as {
    widget?: unknown;
    public_token?: unknown;
    theme?: { color?: unknown; title?: unknown; greeting?: unknown };
    conversation_split_hours?: unknown;
  };
  if (config.widget !== true || typeof config.public_token !== 'string') return null;
  const theme = config.theme ?? {};
  return {
    id: channel.id,
    name: channel.name,
    publicToken: config.public_token,
    theme: {
      color: typeof theme.color === 'string' ? theme.color : DEFAULT_THEME.color,
      title: typeof theme.title === 'string' ? theme.title : DEFAULT_THEME.title,
      greeting: typeof theme.greeting === 'string' ? theme.greeting : DEFAULT_THEME.greeting,
    },
    splitHours:
      typeof config.conversation_split_hours === 'number' ? config.conversation_split_hours : null,
    isActive: channel.is_active,
    agentId: channel.agent_id ?? null,
  };
}

type TestChannelView = { id: string; name: string; isActive: boolean; agentId: string | null };

/** Extracts a manual test channel (type=chat, config.test); null otherwise. */
function toTestChannelView(channel: Channel): TestChannelView | null {
  if (channel.type !== 'chat') return null;
  const config = channel.config as { test?: unknown };
  if (config.test !== true) return null;
  return {
    id: channel.id,
    name: channel.name,
    isActive: channel.is_active,
    agentId: channel.agent_id ?? null,
  };
}

type IntakeChannelView = {
  id: string;
  name: string;
  address: string;
  purpose: 'form' | 'forwarded_email';
  isActive: boolean;
  agentId: string | null;
};

/** Extracts an inbound-email intake channel; returns null for other channels. */
function toIntakeChannelView(channel: Channel): IntakeChannelView | null {
  if (channel.type !== 'email') return null;
  const config = channel.config as { mode?: unknown; address?: unknown; purpose?: unknown };
  if (config.mode !== 'inbound' || typeof config.address !== 'string') return null;
  return {
    id: channel.id,
    name: channel.name,
    address: config.address,
    // legacy rows without a purpose are contact-form intakes
    purpose: config.purpose === 'forwarded_email' ? 'forwarded_email' : 'form',
    isActive: channel.is_active,
    agentId: channel.agent_id ?? null,
  };
}

type WhatsappChannelView = {
  id: string;
  name: string;
  sender: string;
  splitHours: number | null;
  isActive: boolean;
  agentId: string | null;
};

/** Extracts a Twilio WhatsApp channel; returns null for other channels/providers. */
function toWhatsappChannelView(channel: Channel): WhatsappChannelView | null {
  if (channel.type !== 'whatsapp') return null;
  const config = channel.config as {
    provider?: unknown;
    sender?: unknown;
    conversationSplitHours?: unknown;
  };
  if (config.provider !== 'twilio' || typeof config.sender !== 'string') return null;
  return {
    id: channel.id,
    name: channel.name,
    sender: config.sender,
    splitHours:
      typeof config.conversationSplitHours === 'number' ? config.conversationSplitHours : null,
    isActive: channel.is_active,
    agentId: channel.agent_id ?? null,
  };
}

type VoiceChannelView = {
  id: string;
  name: string;
  phoneNumber: string;
  greeting: string;
  greetingInterruptible: boolean;
  voice: string;
  languageHint: string;
  keyterms: string;
  speechSpeed: number;
  transferNumber: string;
  recordingEnabled: boolean;
  isActive: boolean;
  agentId: string | null;
};

/** Extracts a voice channel for the agent-settings card; null for other channels. */
function toVoiceChannelView(channel: Channel): VoiceChannelView | null {
  if (channel.type !== 'voice') return null;
  const config = channel.config as {
    provider?: unknown;
    phoneNumber?: unknown;
    greeting?: unknown;
    greetingInterruptible?: unknown;
    voice?: unknown;
    languageHint?: unknown;
    keyterms?: unknown;
    speechSpeed?: unknown;
    transferNumber?: unknown;
    recordingEnabled?: unknown;
  };
  if (config.provider !== 'xai' || typeof config.phoneNumber !== 'string') return null;
  return {
    id: channel.id,
    name: channel.name,
    phoneNumber: config.phoneNumber,
    greeting: typeof config.greeting === 'string' ? config.greeting : '',
    greetingInterruptible: config.greetingInterruptible === true,
    voice: typeof config.voice === 'string' ? config.voice : 'eve',
    languageHint: typeof config.languageHint === 'string' ? config.languageHint : 'de',
    keyterms: Array.isArray(config.keyterms)
      ? config.keyterms.filter((k): k is string => typeof k === 'string').join(', ')
      : '',
    speechSpeed: typeof config.speechSpeed === 'number' ? config.speechSpeed : 1.0,
    transferNumber: typeof config.transferNumber === 'string' ? config.transferNumber : '',
    recordingEnabled: config.recordingEnabled === true,
    isActive: channel.is_active,
    agentId: channel.agent_id ?? null,
  };
}

/** Conversation languages offered for voice channels (ASR hint + spoken language). */
const VOICE_LANGUAGES: { code: string; label: string }[] = [
  { code: 'de', label: 'Deutsch' },
  { code: 'en', label: 'Englisch' },
  { code: 'fr', label: 'Französisch' },
  { code: 'es', label: 'Spanisch' },
  { code: 'it', label: 'Italienisch' },
  { code: 'nl', label: 'Niederländisch' },
  { code: 'pl', label: 'Polnisch' },
  { code: 'tr', label: 'Türkisch' },
];

const textareaStyle: CSSProperties = {
  width: '100%',
  padding: '0.55rem 0.75rem',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: '0.95rem',
  fontFamily: 'inherit',
  background: 'var(--surface)',
  resize: 'vertical',
};

const helpStyle: CSSProperties = {
  fontSize: '0.9rem',
  color: 'var(--text-muted)',
  marginBottom: '1.25rem',
};

/** Per-channel Aktiv/Inaktiv toggle — one click flips is_active. */
function ActiveToggle({
  orgId,
  channelId,
  isActive,
}: {
  orgId: string;
  channelId: string;
  isActive: boolean;
}) {
  return (
    <form action={setChannelActive}>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="channelId" value={channelId} />
      <input type="hidden" name="active" value={isActive ? 'false' : 'true'} />
      <button
        type="submit"
        className={`chan-toggle ${isActive ? 'chan-toggle--active' : 'chan-toggle--inactive'}`}
        title={isActive ? 'Klicken zum Deaktivieren' : 'Klicken zum Aktivieren'}
      >
        {isActive ? 'Aktiv' : 'Inaktiv'}
      </button>
    </form>
  );
}

/**
 * Per-channel agent assignment (0011). Its own <form> — must never be nested
 * inside another form (invalid HTML), so panels render it as a sibling.
 * 0015: only agents of the matching kind are offered — voice channels take
 * voice agents, all other channels take text agents.
 */
function AgentSelect({
  orgId,
  channelId,
  channelType,
  agentId,
  agents,
  disabled,
}: {
  orgId: string;
  channelId: string;
  channelType: Channel['type'];
  agentId: string | null;
  agents: AgentOption[];
  /** Non-owners see the assignment read-only (setChannelAgent is owner-gated). */
  disabled: boolean;
}) {
  const requiredKind: AgentKind = channelType === 'voice' ? 'voice' : 'text';
  const eligible = agents.filter((a) => a.kind === requiredKind);
  return (
    <form
      action={setChannelAgent}
      style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginTop: '0.5rem' }}
    >
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="channelId" value={channelId} />
      <select
        name="agentId"
        defaultValue={agentId ?? ''}
        aria-label="Agent"
        disabled={disabled}
        style={{ maxWidth: '18rem' }}
      >
        <option value="">— kein Agent (keine KI-Antworten) —</option>
        {eligible.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
            {agent.is_active ? '' : ' (pausiert)'}
          </option>
        ))}
      </select>
      {disabled ? null : (
        <button className="ghost" type="submit">
          Agent zuweisen
        </button>
      )}
    </form>
  );
}

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, orgs, role } = await requireActiveOrg(org);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const isOwner = role === 'owner';
  const [channels, agentOptions, limits, hoursRow] = await Promise.all([
    listChannels(orgId),
    listAgentOptions(orgId),
    loadChannelLimits(orgId),
    (await createSupabaseServerClient())
      .from('org_settings')
      .select('business_hours')
      .eq('org_id', orgId)
      .maybeSingle(),
  ]);
  // 0018: the voice card shows an honest transfer-status line based on hours.
  let businessHours: BusinessHours | null = null;
  const rawHours = (hoursRow.data as { business_hours: unknown } | null)?.business_hours;
  if (rawHours != null) {
    const parsedHours = businessHoursSchema.safeParse(rawHours);
    businessHours = parsedHours.success ? parsedHours.data : null;
  }
  const hoursConfigured = hasConfiguredHours(businessHours);

  // Quotas (0017): no limit row = unlimited. `blocked` gates the create forms;
  // a kind with limit 0 and no existing channels disappears from the gallery.
  const kindCounts = countChannelsByKind(channels);
  const quota = (kind: ChannelKind): { limit: number | null; count: number; blocked: boolean } => {
    const limit = limits.get(kind) ?? null;
    const count = kindCounts.get(kind) ?? 0;
    return { limit, count, blocked: limit !== null && count >= limit };
  };
  const quotaNotice = (kind: ChannelKind): ReactNode => {
    const q = quota(kind);
    if (!q.blocked) return null;
    return (
      <p className="notice" style={{ marginTop: '0.5rem' }}>
        Kontingent erreicht ({q.count} von {q.limit}). Für weitere Kanäle wende dich an Zendori.
      </p>
    );
  };

  const widgetChannels = channels
    .map(toWidgetChannelView)
    .filter((v): v is WidgetChannelView => v !== null);
  const testChannels = channels
    .map(toTestChannelView)
    .filter((v): v is TestChannelView => v !== null);
  const intakeChannels = channels
    .map(toIntakeChannelView)
    .filter((v): v is IntakeChannelView => v !== null);
  const formChannels = intakeChannels.filter((c) => c.purpose === 'form');
  const emailChannels = intakeChannels.filter((c) => c.purpose === 'forwarded_email');
  const whatsappChannels = channels
    .map(toWhatsappChannelView)
    .filter((v): v is WhatsappChannelView => v !== null);
  const voiceChannels = channels
    .map(toVoiceChannelView)
    .filter((v): v is VoiceChannelView => v !== null);

  // strip a trailing slash so the displayed URL matches what the route reconstructs
  const whatsappTwilioWebhookUrl = `${appUrl().replace(/\/+$/, '')}/api/hooks/whatsapp/twilio`;
  const embedBase = appUrl();

  const meta = (
    key: TileKey,
    name: string,
    description: string,
    list: { isActive: boolean }[]
  ): TileMeta => ({
    key,
    name,
    description,
    activeCount: list.filter((c) => c.isActive).length,
    totalCount: list.length,
  });

  const tiles: TileMeta[] = [
    meta('form', 'Formular', 'Kontaktformulare beliebiger Websites — als Empfänger eintragen.', formChannels),
    meta('email', 'E-Mail', 'Bestehende Postfächer per Weiterleitung anbinden.', emailChannels),
    meta('whatsapp', 'WhatsApp', 'WhatsApp-Nummern deines Unternehmens (Twilio).', whatsappChannels),
    meta('voice', 'Voice', 'Telefon-Anrufe nimmt der KI-Sprachassistent entgegen.', voiceChannels),
    meta('chat', 'Chat', 'Embeddable Chat-Widget für deine Website.', widgetChannels),
    meta('test', 'Test', 'Nachrichten manuell einspeisen — zum Ausprobieren.', testChannels),
    // A kind locked to 0 with nothing provisioned is removed from the gallery
    // entirely ("ausgebaut") — existing channels keep their tile visible.
  ].filter((tile) => !(quota(tile.key as ChannelKind).limit === 0 && tile.totalCount === 0));

  // --- panels ------------------------------------------------------------------

  const formPanel: ReactNode = (
    <div className="panel">
      <h2>Formular-Anfragen</h2>
      <p style={helpStyle}>
        An diese Adressen gesendete E-Mails (als Empfänger oder in CC) landen automatisch in der
        Inbox. Ideal für Kontaktformulare beliebiger Websites: einfach die Adresse als Empfänger
        eintragen — kein Code auf der Kundenseite nötig. Der echte Absender wird aus dem
        Formular-Inhalt extrahiert.
      </p>
      {formChannels.length === 0 ? (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Noch keine Formular-Adresse angelegt.
        </p>
      ) : (
        <div style={{ marginBottom: '1.5rem' }}>
          {formChannels.map((intake) => (
            <div key={intake.id} className="chan-instance">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="chan-instance-name">{intake.name}</div>
                <code className="invite-link">{intake.address}</code>
                <AgentSelect
                  orgId={orgId}
                  channelId={intake.id}
                  channelType="email"
                  agentId={intake.agentId}
                  agents={agentOptions}
                  disabled={!isOwner}
                />
              </div>
              <ActiveToggle orgId={orgId} channelId={intake.id} isActive={intake.isActive} />
            </div>
          ))}
        </div>
      )}
      {quotaNotice('form')}
      {quota('form').blocked ? null : (
      <form className="stack" action={createIntakeAddress} style={{ maxWidth: '26rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="purpose" value="form" />
        <div>
          <label htmlFor="form-name">Name</label>
          <input
            id="form-name"
            name="name"
            type="text"
            required
            minLength={2}
            maxLength={120}
            placeholder="z. B. Kontaktformular strong-energy.eu"
          />
        </div>
        <div>
          <label htmlFor="form-slug">Kürzel (für die Adresse)</label>
          <input id="form-slug" name="slugPart" type="text" required maxLength={40} placeholder="z. B. kf" />
        </div>
        <button className="primary" type="submit">
          Formular-Adresse anlegen
        </button>
      </form>
      )}
    </div>
  );

  const emailPanel: ReactNode = (
    <div className="panel">
      <h2>E-Mail-Weiterleitung</h2>
      <p style={helpStyle}>
        Binde ein bestehendes Postfach an, indem du dort eine Weiterleitung auf die generierte
        Adresse einrichtest. Weitergeleitete Mails landen in der Inbox; der echte Absender wird aus
        dem Weiterleitungs-Header übernommen. Eigene Adresse je Postfach = eigener Kanal.
      </p>
      {emailChannels.length === 0 ? (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Noch keine E-Mail-Adresse angelegt.
        </p>
      ) : (
        <div style={{ marginBottom: '1.5rem' }}>
          {emailChannels.map((intake) => (
            <div key={intake.id} className="chan-instance">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="chan-instance-name">{intake.name}</div>
                <code className="invite-link">{intake.address}</code>
                <AgentSelect
                  orgId={orgId}
                  channelId={intake.id}
                  channelType="email"
                  agentId={intake.agentId}
                  agents={agentOptions}
                  disabled={!isOwner}
                />
              </div>
              <ActiveToggle orgId={orgId} channelId={intake.id} isActive={intake.isActive} />
            </div>
          ))}
        </div>
      )}
      {quotaNotice('email')}
      {quota('email').blocked ? null : (
      <form className="stack" action={createIntakeAddress} style={{ maxWidth: '26rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="purpose" value="forwarded_email" />
        <div>
          <label htmlFor="email-name">Name</label>
          <input
            id="email-name"
            name="name"
            type="text"
            required
            minLength={2}
            maxLength={120}
            placeholder="z. B. Support-Postfach strong-energy.eu"
          />
        </div>
        <div>
          <label htmlFor="email-slug">Kürzel (für die Adresse)</label>
          <input id="email-slug" name="slugPart" type="text" required maxLength={40} placeholder="z. B. support" />
        </div>
        <button className="primary" type="submit">
          E-Mail-Adresse anlegen
        </button>
      </form>
      )}
    </div>
  );

  // Ticket separation ("Neue Unterhaltung nach Inaktivität") — owner-only,
  // shared by the WhatsApp and widget cards. '' = never split.
  const SPLIT_PRESETS = [24, 72, 168];
  const conversationSplitForm = (channelId: string, current: number | null): ReactNode => (
    <form action={updateConversationSplit} style={{ marginTop: '0.6rem' }}>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="channelId" value={channelId} />
      <label
        htmlFor={`split-${channelId}`}
        style={{ fontSize: '0.85rem', fontWeight: 600, display: 'block' }}
      >
        Neue Unterhaltung nach Inaktivität
      </label>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.3rem' }}>
        <select
          id={`split-${channelId}`}
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
        <button className="ghost" type="submit" disabled={!isOwner}>
          Speichern
        </button>
      </div>
      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
        Schreibt der Kontakt nach dieser Zeit erneut, beginnt ein neues Ticket. Unterhaltungen,
        die gerade auf euch warten, werden nie getrennt.
      </p>
    </form>
  );

  const whatsappPanel: ReactNode = (
    <div className="panel">
      <h2>WhatsApp (Twilio)</h2>
      <p style={helpStyle}>
        Eine Twilio-WhatsApp-Nummer je Kunde. Nachrichten an diese Nummer landen in der Inbox,
        Antworten gehen über Twilio zurück. Nach dem Anlegen die unten angezeigte Webhook-URL im
        Twilio-Console bei der Nummer (oder Messaging Service) unter „A message comes in" (Methode
        POST) eintragen.
      </p>
      {whatsappChannels.length === 0 ? (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Noch keine WhatsApp-Nummer verbunden.
        </p>
      ) : (
        <div style={{ marginBottom: '1.5rem' }}>
          {whatsappChannels.map((wa) => (
            <div key={wa.id} className="chan-instance">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="chan-instance-name">{wa.name}</div>
                <code className="invite-link">{wa.sender}</code>
                <AgentSelect
                  orgId={orgId}
                  channelId={wa.id}
                  channelType="whatsapp"
                  agentId={wa.agentId}
                  agents={agentOptions}
                  disabled={!isOwner}
                />
                {conversationSplitForm(wa.id, wa.splitHours)}
              </div>
              <ActiveToggle orgId={orgId} channelId={wa.id} isActive={wa.isActive} />
            </div>
          ))}
        </div>
      )}
      <div style={{ marginBottom: '1.5rem' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Webhook-URL (in Twilio eintragen)</span>
        <code className="invite-link">{whatsappTwilioWebhookUrl}</code>
      </div>
      {quotaNotice('whatsapp')}
      {quota('whatsapp').blocked ? null : (
      <form className="stack" action={createWhatsappTwilioChannel} style={{ maxWidth: '26rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <div>
          <label htmlFor="wa-name">Name</label>
          <input
            id="wa-name"
            name="name"
            type="text"
            required
            minLength={2}
            maxLength={120}
            placeholder="z. B. WhatsApp Support strong-energy.eu"
          />
        </div>
        <div>
          <label htmlFor="wa-sender">Absendernummer (+E164)</label>
          <input id="wa-sender" name="sender" type="text" required placeholder="+493012345678" />
        </div>
        <div>
          <label htmlFor="wa-account-sid">Twilio Account SID</label>
          <input id="wa-account-sid" name="accountSid" type="text" required placeholder="AC…" />
        </div>
        <div>
          <label htmlFor="wa-auth-token">Twilio Auth Token</label>
          <input
            id="wa-auth-token"
            name="authToken"
            type="password"
            required
            autoComplete="off"
            placeholder="wird verschlüsselt gespeichert"
          />
        </div>
        <div>
          <label htmlFor="wa-messaging-service">Messaging Service SID (optional)</label>
          <input
            id="wa-messaging-service"
            name="messagingServiceSid"
            type="text"
            placeholder="MG… (optional)"
          />
        </div>
        <button className="primary" type="submit">
          WhatsApp-Nummer verbinden
        </button>
      </form>
      )}
    </div>
  );

  const voicePanel: ReactNode = (
    <div className="panel">
      <h2>Telefon (Voice-Agent)</h2>
      <p style={helpStyle}>
        Anrufe auf der Voice-Nummer nimmt der KI-Sprachassistent entgegen. Gespräche erscheinen als
        Konversationen in der Inbox. Die Nummer beantragst du unter{' '}
        <Link href={`/settings/phone-numbers?org=${orgId}`}>Einstellungen → Telefonnummern</Link>;
        hier konfigurierst du Stimme, Sprache und Begrüßung — Verhalten und Identität kommen vom
        zugewiesenen Voice-Agenten.
      </p>
      {voiceChannels.length === 0 ? (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Noch kein Voice-Kanal eingerichtet. Beantrage unter{' '}
          <Link href={`/settings/phone-numbers?org=${orgId}`}>Telefonnummern</Link> eine Nummer —
          nach der Einrichtung erscheint hier die Konfiguration.
        </p>
      ) : (
        voiceChannels.map((vc) => {
          const assignedAgent = agentOptions.find((a) => a.id === vc.agentId) ?? null;
          const greetingAgentMode: 'answer' | 'intake' | null = assignedAgent
            ? assignedAgent.mode === 'autopilot'
              ? 'answer'
              : 'intake'
            : null;
          return (
          <div key={vc.id} style={{ marginBottom: '2rem' }}>
            {/* header outside the settings form: ActiveToggle/AgentSelect are
                their own forms and must never nest inside another form */}
            <div
              className="chan-instance"
              style={{ borderBottom: '1px solid var(--border)', marginBottom: '1rem' }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="chan-instance-name">{vc.name}</div>
                <code className="invite-link">{vc.phoneNumber}</code>
                <AgentSelect
                  orgId={orgId}
                  channelId={vc.id}
                  channelType="voice"
                  agentId={vc.agentId}
                  agents={agentOptions}
                  disabled={!isOwner}
                />
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                  Verhalten und Identität steuert der zugewiesene Voice-Agent (Reine Annahme oder
                  Autopilot). Ohne Agent nimmt der Assistent Anrufe im sicheren Annahme-Modus
                  entgegen.
                </p>
                {/* 0018: honest transfer status at a glance */}
                <p
                  style={{
                    fontSize: '0.8rem',
                    marginTop: '0.35rem',
                    color: vc.transferNumber ? 'var(--success-ink)' : 'var(--warn)',
                  }}
                >
                  {vc.transferNumber
                    ? hoursConfigured
                      ? `📞 Live-Weiterleitung an ${vc.transferNumber} innerhalb der Geschäftszeiten — außerhalb: Rückruf-Ticket.`
                      : `📞 Live-Weiterleitung an ${vc.transferNumber} (jederzeit — keine Geschäftszeiten gepflegt).`
                    : 'Keine Transfer-Nummer — Übergaben werden als Rückruf-Ticket aufgenommen.'}
                </p>
              </div>
              <ActiveToggle orgId={orgId} channelId={vc.id} isActive={vc.isActive} />
            </div>
            <form
              className="stack"
              action={updateVoiceChannelSettings}
              style={{ maxWidth: '30rem' }}
            >
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="channelId" value={vc.id} />
            {/* the action is owner-gated — read-only for members instead of a
                data-losing rejection on submit */}
            <fieldset disabled={!isOwner} style={{ border: 'none', padding: 0, margin: 0, display: 'contents' }}>
            <div>
              <label htmlFor={`voice-greeting-${vc.id}`}>Begrüßung (Welcome Message)</label>
              <input
                id={`voice-greeting-${vc.id}`}
                name="greeting"
                type="text"
                maxLength={500}
                defaultValue={vc.greeting}
                placeholder="Leer = der Agent begrüßt frei"
              />
              <GreetingSuggestion
                inputId={`voice-greeting-${vc.id}`}
                companyName={orgName}
                agentMode={greetingAgentMode}
              />
              <label
                htmlFor={`voice-greeting-int-${vc.id}`}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem', fontWeight: 400 }}
              >
                <input
                  id={`voice-greeting-int-${vc.id}`}
                  name="greetingInterruptible"
                  type="checkbox"
                  defaultChecked={vc.greetingInterruptible}
                  style={{ width: 'auto' }}
                />
                Anrufer darf die Begrüßung unterbrechen
              </label>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                Standard: aus — die Begrüßung wird immer vollständig gesprochen, auch wenn der
                Anrufer hineinredet.
              </p>
            </div>
            <div>
              <label htmlFor={`voice-voice-${vc.id}`}>Stimme</label>
              <VoicePicker id={`voice-voice-${vc.id}`} name="voice" defaultVoice={vc.voice} />
            </div>
            <div>
              <label htmlFor={`voice-language-${vc.id}`}>Sprache des Voice-Agents</label>
              <select
                id={`voice-language-${vc.id}`}
                name="languageHint"
                defaultValue={vc.languageHint}
              >
                {VOICE_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                Gesprächs- und Erkennungssprache. Spricht der Anrufer eine andere Sprache, wechselt
                der Assistent automatisch.
              </p>
            </div>
            <div>
              <label htmlFor={`voice-keyterms-${vc.id}`}>
                Fachbegriffe (kommagetrennt, verbessern die Erkennung)
              </label>
              <input
                id={`voice-keyterms-${vc.id}`}
                name="keyterms"
                type="text"
                maxLength={4000}
                defaultValue={vc.keyterms}
                placeholder="z. B. Produktnamen, Markennamen"
              />
            </div>
            <div>
              <label htmlFor={`voice-speed-${vc.id}`}>Sprechtempo (0,7–1,5)</label>
              <input
                id={`voice-speed-${vc.id}`}
                name="speechSpeed"
                type="number"
                step="0.05"
                min="0.7"
                max="1.5"
                defaultValue={vc.speechSpeed}
              />
            </div>
            <div>
              <label htmlFor={`voice-transfer-${vc.id}`}>
                Transfer-Nummer (optional, für Live-Weiterleitung an einen Menschen)
              </label>
              <input
                id={`voice-transfer-${vc.id}`}
                name="transferNumber"
                type="text"
                defaultValue={vc.transferNumber}
                placeholder="+49301234567 (leer = Rückruf-Ticket)"
              />
            </div>
            <div>
              <label
                htmlFor={`voice-recording-${vc.id}`}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
              >
                <input
                  id={`voice-recording-${vc.id}`}
                  name="recordingEnabled"
                  type="checkbox"
                  defaultChecked={vc.recordingEnabled}
                  style={{ width: 'auto' }}
                />
                Anrufe aufzeichnen
              </label>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                Der Assistent spricht zu Gesprächsbeginn einen Aufzeichnungshinweis (gesetzlich
                erforderlich, § 201 StGB). Die Aufnahme erscheint nach dem Anruf als Anhang in der
                Konversation und wird in der EU gespeichert.
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
        })
      )}
    </div>
  );

  const chatPanel: ReactNode = (
    <div className="panel">
      <h2>Chat-Widget</h2>
      <p style={helpStyle}>
        Das Chat-Widget wird mit einem einzigen Script-Tag in beliebige Websites eingebunden.
        Nachrichten aus dem Widget erscheinen als Konversationen in der Inbox. Ausprobieren:{' '}
        <Link href={`/widget-demo?org=${orgId}`}>Widget-Demo</Link>.
      </p>

      {widgetChannels.map((widget) => (
        <div key={widget.id} style={{ marginBottom: '2rem' }}>
          <div
            className="chan-instance"
            style={{ borderBottom: '1px solid var(--border)', marginBottom: '1rem' }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="chan-instance-name">{widget.name}</div>
              <AgentSelect
                orgId={orgId}
                channelId={widget.id}
                channelType="chat"
                agentId={widget.agentId}
                agents={agentOptions}
                disabled={!isOwner}
              />
              {conversationSplitForm(widget.id, widget.splitHours)}
            </div>
            <ActiveToggle orgId={orgId} channelId={widget.id} isActive={widget.isActive} />
          </div>
          <form className="stack" action={updateWidgetTheme} style={{ maxWidth: '26rem' }}>
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="channelId" value={widget.id} />
            <div>
              <label htmlFor={`widget-color-${widget.id}`}>Farbe</label>
              <input
                id={`widget-color-${widget.id}`}
                name="color"
                type="color"
                defaultValue={widget.theme.color}
              />
            </div>
            <div>
              <label htmlFor={`widget-title-${widget.id}`}>Titel</label>
              <input
                id={`widget-title-${widget.id}`}
                name="title"
                type="text"
                required
                minLength={1}
                maxLength={60}
                defaultValue={widget.theme.title}
              />
            </div>
            <div>
              <label htmlFor={`widget-greeting-${widget.id}`}>Begrüßung</label>
              <textarea
                id={`widget-greeting-${widget.id}`}
                name="greeting"
                rows={3}
                required
                maxLength={300}
                defaultValue={widget.theme.greeting}
                style={textareaStyle}
              />
            </div>
            <button className="primary" type="submit">
              Theme speichern
            </button>
          </form>
          <div style={{ marginTop: '1.25rem' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Embed-Code</span>
            <code className="invite-link">
              {`<script src="${embedBase}/widget.js" data-zendori-token="${widget.publicToken}" async></script>`}
            </code>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
              Diesen Code auf der Website vor dem schließenden &lt;/body&gt;-Tag einfügen. Der Token
              ist öffentlich — er identifiziert nur den Kanal und enthält keine Geheimnisse.
            </p>
          </div>
        </div>
      ))}

      {quotaNotice('chat')}
      {quota('chat').blocked ? null : (
      <form className="stack" action={createWidgetChannel} style={{ maxWidth: '26rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <div>
          <label htmlFor="widget-name">Name</label>
          <input
            id="widget-name"
            name="name"
            type="text"
            required
            minLength={2}
            maxLength={80}
            placeholder="z. B. Website-Chat zendori.de"
          />
        </div>
        <button className="primary" type="submit">
          Widget-Channel anlegen
        </button>
      </form>
      )}
    </div>
  );

  const testPanel: ReactNode = (
    <div className="panel">
      <h2>Test-Channel</h2>
      <p style={helpStyle}>
        Ein Test-Channel dient zum manuellen Einspeisen von Nachrichten über den{' '}
        <Link href={`/test-channel?org=${orgId}`}>Test-Channel</Link>. Praktisch, um Inbox, KI und
        Zuweisung ohne echten Kanal auszuprobieren.
      </p>
      {testChannels.length > 0 ? (
        <div style={{ marginBottom: '1.5rem' }}>
          {testChannels.map((tc) => (
            <div key={tc.id} className="chan-instance">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="chan-instance-name">{tc.name}</div>
                <AgentSelect
                  orgId={orgId}
                  channelId={tc.id}
                  channelType="chat"
                  agentId={tc.agentId}
                  agents={agentOptions}
                  disabled={!isOwner}
                />
              </div>
              <ActiveToggle orgId={orgId} channelId={tc.id} isActive={tc.isActive} />
            </div>
          ))}
        </div>
      ) : null}
      {quotaNotice('test')}
      {quota('test').blocked ? null : (
      <form className="stack" action={createTestChannel} style={{ maxWidth: '26rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <div>
          <label htmlFor="test-name">Name</label>
          <input
            id="test-name"
            name="name"
            type="text"
            required
            minLength={2}
            placeholder="z. B. Test-Kanal Support"
          />
        </div>
        <button className="primary" type="submit">
          Test-Channel anlegen
        </button>
      </form>
      )}
    </div>
  );

  const panels: Record<TileKey, ReactNode> = {
    form: formPanel,
    email: emailPanel,
    whatsapp: whatsappPanel,
    voice: voicePanel,
    chat: chatPanel,
    test: testPanel,
  };

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Kanäle</h1>
        <p>
          Alle Kanäle von {orgName} auf einen Blick. Wähle einen Kanal, um ihn einzurichten und zu
          aktivieren.
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

      <ChannelGallery tiles={tiles} panels={panels} />
    </div>
  );
}
