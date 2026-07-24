// Shared pieces of the two-level channels UI (list + detail, owner 2026-07-24):
// config extractors per channel flavor, the ActiveToggle/AgentSelect mini-forms
// (own <form>s — must never nest inside another form) and small option lists.
import type { AgentKind, AgentMode, Channel } from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { DEFAULT_THEME, type WidgetTheme } from '@/lib/widget/session';
import { setChannelActive, setChannelAgent } from './actions';

export type AgentOption = {
  id: string;
  name: string;
  is_active: boolean;
  kind: AgentKind;
  mode: AgentMode;
};

export async function listAgentOptions(orgId: string): Promise<AgentOption[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('agents')
    .select('id, name, is_active, kind, mode')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  return (data ?? []) as AgentOption[];
}

// --- flavor views -------------------------------------------------------------

export type ChannelFlavor =
  | 'webform'
  | 'form'
  | 'email'
  | 'whatsapp'
  | 'voice'
  | 'chat'
  | 'test';

export const FLAVOR_LABELS: Record<ChannelFlavor, string> = {
  webform: 'Web-Formular',
  form: 'Formular-Weiterleitung',
  email: 'E-Mail-Weiterleitung',
  whatsapp: 'WhatsApp',
  voice: 'Telefon',
  chat: 'Chat-Widget',
  test: 'Test',
};

export type WidgetChannelView = {
  id: string;
  name: string;
  publicToken: string;
  theme: WidgetTheme;
  splitHours: number | null;
  isActive: boolean;
  agentId: string | null;
};

/** Extracts the widget config from a channel row; returns null for non-widget channels. */
export function toWidgetChannelView(channel: Channel): WidgetChannelView | null {
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

export type WebformChannelView = {
  id: string;
  name: string;
  isActive: boolean;
  agentId: string | null;
};

/** Extracts a form-builder channel (email + config.builderForm); null otherwise. */
export function toWebformChannelView(channel: Channel): WebformChannelView | null {
  if (channel.type !== 'email') return null;
  const config = channel.config as { builderForm?: unknown };
  if (config.builderForm !== true) return null;
  return {
    id: channel.id,
    name: channel.name,
    isActive: channel.is_active,
    agentId: channel.agent_id ?? null,
  };
}

export type TestChannelView = {
  id: string;
  name: string;
  isActive: boolean;
  agentId: string | null;
};

/** Extracts a manual test channel (type=chat, config.test); null otherwise. */
export function toTestChannelView(channel: Channel): TestChannelView | null {
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

export type IntakeChannelView = {
  id: string;
  name: string;
  address: string;
  purpose: 'form' | 'forwarded_email';
  isActive: boolean;
  agentId: string | null;
};

/** Extracts an inbound-email intake channel; returns null for other channels.
 *  Builder-form channels (config.builderForm, Phase 10) have their own flavor. */
export function toIntakeChannelView(channel: Channel): IntakeChannelView | null {
  if (channel.type !== 'email') return null;
  const config = channel.config as {
    mode?: unknown;
    address?: unknown;
    purpose?: unknown;
    builderForm?: unknown;
  };
  if (config.builderForm === true) return null;
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

export type WhatsappChannelView = {
  id: string;
  name: string;
  sender: string;
  splitHours: number | null;
  isActive: boolean;
  agentId: string | null;
};

/** Extracts a Twilio WhatsApp channel; returns null for other channels/providers. */
export function toWhatsappChannelView(channel: Channel): WhatsappChannelView | null {
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

export type VoiceChannelView = {
  id: string;
  name: string;
  phoneNumber: string;
  greeting: string;
  greetingInterruptible: boolean;
  farewell: string;
  voice: string;
  languageHint: string;
  keyterms: string;
  speechSpeed: number;
  transferNumber: string;
  recordingEnabled: boolean;
  isActive: boolean;
  agentId: string | null;
};

/** Extracts a voice channel; null for other channels. */
export function toVoiceChannelView(channel: Channel): VoiceChannelView | null {
  if (channel.type !== 'voice') return null;
  const config = channel.config as {
    provider?: unknown;
    phoneNumber?: unknown;
    greeting?: unknown;
    greetingInterruptible?: unknown;
    farewell?: unknown;
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
    farewell: typeof config.farewell === 'string' ? config.farewell : '',
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

/** The flavor of a raw channel row (drives labels, list identity, detail layout). */
export function channelFlavor(channel: Channel): ChannelFlavor {
  if (channel.type === 'voice') return 'voice';
  if (channel.type === 'whatsapp') return 'whatsapp';
  if (channel.type === 'email') {
    if ((channel.config as { builderForm?: unknown }).builderForm === true) return 'webform';
    return toIntakeChannelView(channel)?.purpose === 'forwarded_email' ? 'email' : 'form';
  }
  // chat: widget or test
  return (channel.config as { test?: unknown }).test === true ? 'test' : 'chat';
}

/** The identifying detail shown in the overview (address, number, token …). */
export function channelIdentifier(channel: Channel): string {
  const flavor = channelFlavor(channel);
  if (flavor === 'form' || flavor === 'email') {
    return toIntakeChannelView(channel)?.address ?? '—';
  }
  if (flavor === 'whatsapp') return toWhatsappChannelView(channel)?.sender ?? '—';
  if (flavor === 'voice') return toVoiceChannelView(channel)?.phoneNumber ?? '—';
  if (flavor === 'chat') return 'Widget-Embed';
  if (flavor === 'webform') return 'Formular-Embed';
  return 'manuell';
}

/** Conversation languages offered for voice channels (ASR hint + spoken language). */
export const VOICE_LANGUAGES: { code: string; label: string }[] = [
  { code: 'de', label: 'Deutsch' },
  { code: 'en', label: 'Englisch' },
  { code: 'fr', label: 'Französisch' },
  { code: 'es', label: 'Spanisch' },
  { code: 'it', label: 'Italienisch' },
  { code: 'nl', label: 'Niederländisch' },
  { code: 'pl', label: 'Polnisch' },
  { code: 'tr', label: 'Türkisch' },
];

/** Per-channel Aktiv/Inaktiv toggle — one click flips is_active. */
export function ActiveToggle({
  orgId,
  channelId,
  isActive,
  returnTo,
}: {
  orgId: string;
  channelId: string;
  isActive: boolean;
  /** Detail-page path to return to (validated in the action). */
  returnTo?: string;
}) {
  return (
    <form action={setChannelActive}>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="channelId" value={channelId} />
      <input type="hidden" name="active" value={isActive ? 'false' : 'true'} />
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
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
 * inside another form (invalid HTML). 0015: only agents of the matching kind
 * are offered — voice channels take voice agents, everything else text agents.
 */
export function AgentSelect({
  orgId,
  channelId,
  channelType,
  agentId,
  agents,
  disabled,
  returnTo,
}: {
  orgId: string;
  channelId: string;
  channelType: Channel['type'];
  agentId: string | null;
  agents: AgentOption[];
  /** Non-owners see the assignment read-only (setChannelAgent is owner-gated). */
  disabled: boolean;
  /** Detail-page path to return to (validated in the action). */
  returnTo?: string;
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
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
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
