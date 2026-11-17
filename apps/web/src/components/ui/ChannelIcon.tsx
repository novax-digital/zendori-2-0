// Channel mark (redesign stage 3): a small tinted square with the channel's
// icon — the ONLY place a channel colour appears next to plain text.
//   <ChannelIcon kind={channelFlavor(channel)} /> E-Mail Support
// `kind` accepts the channel flavors of settings/channels/shared.tsx and the
// plain channel types (chat | email | whatsapp | voice).
import Icon, { type IconName } from './Icon';

export type ChannelKind = 'email' | 'form' | 'webform' | 'voice' | 'whatsapp' | 'chat' | 'test';

const MARK: Record<ChannelKind, { icon: IconName; tone: string; label: string }> = {
  email: { icon: 'mail', tone: 'email', label: 'E-Mail' },
  form: { icon: 'form', tone: 'form', label: 'Formular' },
  webform: { icon: 'webform', tone: 'form', label: 'Web-Formular' },
  voice: { icon: 'phone', tone: 'voice', label: 'Telefon' },
  whatsapp: { icon: 'whatsapp', tone: 'whatsapp', label: 'WhatsApp' },
  chat: { icon: 'chat', tone: 'chat', label: 'Chat' },
  test: { icon: 'flask', tone: 'test', label: 'Test' },
};

export default function ChannelIcon({
  kind,
  size = 'sm',
}: {
  kind: ChannelKind | string;
  /** 'sm' = 24px (lists, tables), 'md' = 32px (channel table, option rows). */
  size?: 'sm' | 'md';
}) {
  const mark = MARK[kind as ChannelKind] ?? MARK.test;
  return (
    <span
      className={`ch-icon ch-icon--${mark.tone}${size === 'md' ? ' ch-icon--md' : ''}`}
      role="img"
      aria-label={mark.label}
    >
      <Icon name={mark.icon} size={size === 'md' ? 16 : 14} />
    </span>
  );
}
