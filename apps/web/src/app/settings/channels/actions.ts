'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { DEFAULT_THEME, generatePublicToken } from '@/lib/widget/session';

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function channelsUrl(org: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/settings/channels?${params.toString()}`;
}

// --- create widget channel -----------------------------------------------------

const createWidgetChannelSchema = z.object({
  org: z.uuid(),
  name: z.string().min(2).max(80),
});

export async function createWidgetChannel(formData: FormData): Promise<void> {
  const parsed = createWidgetChannelSchema.safeParse({
    org: formData.get('org'),
    name: textField(formData.get('name')),
  });
  if (!parsed.success) {
    redirect(
      channelsUrl(textField(formData.get('org')), {
        error: 'Bitte einen Namen mit 2–80 Zeichen angeben.',
      })
    );
  }
  const { org, name } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('channels').insert({
    org_id: org,
    type: 'chat',
    name,
    config: { widget: true, public_token: generatePublicToken(), theme: DEFAULT_THEME },
  });
  if (error) {
    redirect(channelsUrl(org, { error: 'Widget-Channel konnte nicht angelegt werden.' }));
  }

  revalidatePath('/settings/channels');
  redirect(channelsUrl(org, { notice: 'Widget-Channel angelegt.' }));
}

// --- update widget theme ---------------------------------------------------------

const updateWidgetThemeSchema = z.object({
  org: z.uuid(),
  channelId: z.uuid(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  title: z.string().min(1).max(60),
  greeting: z.string().min(1).max(300),
});

export async function updateWidgetTheme(formData: FormData): Promise<void> {
  const errorText = 'Theme konnte nicht gespeichert werden.';
  const parsed = updateWidgetThemeSchema.safeParse({
    org: formData.get('org'),
    channelId: formData.get('channelId'),
    color: textField(formData.get('color')),
    title: textField(formData.get('title')),
    greeting: textField(formData.get('greeting')),
  });
  if (!parsed.success) {
    redirect(
      channelsUrl(textField(formData.get('org')), {
        error:
          'Bitte Farbe (Hex, z. B. #4f46e5), Titel (max. 60 Zeichen) und Begrüßung (max. 300 Zeichen) angeben.',
      })
    );
  }
  const { org, channelId, color, title, greeting } = parsed.data;

  const supabase = await createSupabaseServerClient();

  // read-modify-write: preserve public_token, widget flag and any future config keys
  const { data: channelRow } = await supabase
    .from('channels')
    .select('id, config')
    .eq('org_id', org)
    .eq('id', channelId)
    .maybeSingle();
  const channel = channelRow as { id: string; config: Record<string, unknown> } | null;
  if (!channel || channel.config['widget'] !== true) {
    redirect(channelsUrl(org, { error: errorText }));
  }

  const nextConfig = { ...channel.config, theme: { color, title, greeting } };
  const { data, error } = await supabase
    .from('channels')
    .update({ config: nextConfig })
    .eq('org_id', org)
    .eq('id', channelId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(channelsUrl(org, { error: errorText }));
  }

  revalidatePath('/settings/channels');
  redirect(channelsUrl(org, { notice: 'Theme gespeichert.' }));
}
