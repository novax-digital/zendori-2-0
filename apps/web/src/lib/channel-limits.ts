import type { Channel, ChannelKind } from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';

// Per-customer channel quotas (0017). Kind is the UI notion, finer than type —
// MUST mirror private.channel_kind() in SQL exactly (the DB trigger is the
// backstop; this module provides the friendly German pre-check).

export const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = {
  form: 'Formular',
  email: 'E-Mail',
  whatsapp: 'WhatsApp',
  voice: 'Voice',
  chat: 'Chat',
  test: 'Test',
};

/** Mirrors private.channel_kind(type, config) — keep the two in sync. */
export function channelKindOf(channel: Pick<Channel, 'type' | 'config'>): ChannelKind {
  const config = channel.config as Record<string, unknown>;
  if (channel.type === 'email') {
    if (config.mode === 'imap') return 'email';
    return config.purpose === 'forwarded_email' ? 'email' : 'form';
  }
  if (channel.type === 'chat') {
    return config.test === true ? 'test' : 'chat';
  }
  return channel.type;
}

export type ChannelLimits = Map<ChannelKind, number>;

/** Loads the org's configured limits; kinds without a row are unlimited. */
export async function loadChannelLimits(orgId: string): Promise<ChannelLimits> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('org_channel_limits')
    .select('channel_kind, max_count')
    .eq('org_id', orgId);
  const limits: ChannelLimits = new Map();
  for (const row of (data ?? []) as { channel_kind: ChannelKind; max_count: number }[]) {
    limits.set(row.channel_kind, row.max_count);
  }
  return limits;
}

export function countChannelsByKind(
  channels: Pick<Channel, 'type' | 'config'>[]
): Map<ChannelKind, number> {
  const counts = new Map<ChannelKind, number>();
  for (const channel of channels) {
    const kind = channelKindOf(channel);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

/**
 * Pre-check before creating a channel of `kind`: returns a German error string
 * when the org's quota is exhausted, null when creation may proceed. The 0017
 * DB trigger remains the race-safe backstop.
 */
export async function checkChannelQuota(orgId: string, kind: ChannelKind): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const [{ data: limitRow }, { data: channelRows }] = await Promise.all([
    supabase
      .from('org_channel_limits')
      .select('max_count')
      .eq('org_id', orgId)
      .eq('channel_kind', kind)
      .maybeSingle(),
    supabase.from('channels').select('type, config').eq('org_id', orgId),
  ]);
  const limit = (limitRow as { max_count: number } | null)?.max_count;
  if (limit === undefined || limit === null) return null; // no limit configured
  const count =
    countChannelsByKind((channelRows ?? []) as Pick<Channel, 'type' | 'config'>[]).get(kind) ?? 0;
  if (count >= limit) {
    return `Das Kontingent für ${CHANNEL_KIND_LABELS[kind]}-Kanäle ist erreicht (${count} von ${limit}). Für weitere Kanäle wende dich an Zendori.`;
  }
  return null;
}
