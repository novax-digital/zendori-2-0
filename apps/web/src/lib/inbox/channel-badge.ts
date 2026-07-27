import type { ChannelType } from '@zendori/core';

// One fixed badge colour per channel TYPE (not per channel): the colour answers
// "where did this conversation come from" at a glance, however the customer
// named the channel ("Strong Energy Voice Annahmeagent" still reads as Telefon).
const CHANNEL_BADGE: Record<ChannelType, string> = {
  chat: 'badge--channel-chat',
  email: 'badge--channel-email',
  whatsapp: 'badge--channel-whatsapp',
  voice: 'badge--channel-voice',
};

export function channelBadgeClass(type: ChannelType | string): string {
  return `badge ${CHANNEL_BADGE[type as ChannelType] ?? 'badge--muted'}`;
}
