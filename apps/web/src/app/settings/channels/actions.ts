'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { emailInboundConfigSchema, whatsappTwilioConfigSchema } from '@zendori/channels';
import { encryptSecret } from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { DEFAULT_THEME, generatePublicToken } from '@/lib/widget/session';
import { generateIntakeAddress } from '@/lib/email/provisioning';

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

// --- create e-mail intake address ------------------------------------------------

const createIntakeAddressSchema = z.object({
  org: z.uuid(),
  name: z.string().min(2).max(120),
  purpose: z.string().min(1).max(40),
});

/**
 * Provisions a generated, non-guessable inbound e-mail address and creates the
 * matching email/inbound channel. Mails sent to that address (as recipient or
 * CC) reach this org's inbox via the Resend webhook.
 */
export async function createIntakeAddress(formData: FormData): Promise<void> {
  const parsed = createIntakeAddressSchema.safeParse({
    org: formData.get('org'),
    name: textField(formData.get('name')),
    purpose: textField(formData.get('purpose')),
  });
  if (!parsed.success) {
    redirect(
      channelsUrl(textField(formData.get('org')), {
        error: 'Bitte einen Namen (2–120 Zeichen) und einen Zweck (z. B. „kf") angeben.',
      })
    );
  }
  const { org, name, purpose } = parsed.data;

  const supabase = await createSupabaseServerClient();

  // the org slug seeds the readable local part of the intake address
  const { data: orgRow } = await supabase
    .from('organizations')
    .select('slug')
    .eq('id', org)
    .maybeSingle();
  const slug = (orgRow as { slug: string } | null)?.slug;
  if (!slug) {
    redirect(channelsUrl(org, { error: 'Organisation wurde nicht gefunden.' }));
  }

  const address = generateIntakeAddress(slug, purpose);
  // Validate the channel config against the shared schema before persisting.
  const config = emailInboundConfigSchema.safeParse({ type: 'email', mode: 'inbound', address });
  if (!config.success) {
    redirect(channelsUrl(org, { error: 'Intake-Adresse konnte nicht angelegt werden.' }));
  }
  const { error } = await supabase.from('channels').insert({
    org_id: org,
    type: 'email',
    name,
    is_active: true,
    config: config.data,
  });
  if (error) {
    redirect(channelsUrl(org, { error: 'Intake-Adresse konnte nicht angelegt werden.' }));
  }

  revalidatePath('/settings/channels');
  redirect(channelsUrl(org, { notice: 'Intake-Adresse angelegt.' }));
}

// --- connect a WhatsApp channel (Twilio, Phase 7a) -------------------------------

const createWhatsappTwilioSchema = z.object({
  org: z.uuid(),
  name: z.string().min(2).max(120),
  /** Operator-owned sender in +E164. */
  sender: z.string().regex(/^\+[1-9]\d{6,15}$/),
  accountSid: z.string().regex(/^AC[0-9a-zA-Z]{32}$/),
  authToken: z.string().min(10).max(200),
  messagingServiceSid: z
    .string()
    .regex(/^MG[0-9a-zA-Z]{32}$/)
    .optional(),
});

/**
 * Connects a Twilio-owned WhatsApp sender as a channel. The Auth Token (used to
 * both verify inbound signatures and send) is encrypted with MASTER_ENCRYPTION_KEY
 * before it touches the DB; the sender/accountSid are plaintext routing keys.
 */
export async function createWhatsappTwilioChannel(formData: FormData): Promise<void> {
  const rawMsgSvc = textField(formData.get('messagingServiceSid'));
  const parsed = createWhatsappTwilioSchema.safeParse({
    org: formData.get('org'),
    name: textField(formData.get('name')),
    sender: textField(formData.get('sender')),
    accountSid: textField(formData.get('accountSid')),
    authToken: textField(formData.get('authToken')),
    messagingServiceSid: rawMsgSvc === '' ? undefined : rawMsgSvc,
  });
  if (!parsed.success) {
    redirect(
      channelsUrl(textField(formData.get('org')), {
        error:
          'Bitte Nummer (+49…), Account SID (AC…), Auth Token und optional Messaging Service SID (MG…) angeben.',
      })
    );
  }
  const { org, name, sender, accountSid, authToken, messagingServiceSid } = parsed.data;

  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  if (!masterKey) {
    redirect(channelsUrl(org, { error: 'Verschlüsselung ist serverseitig nicht konfiguriert.' }));
  }
  const authTokenEncrypted = await encryptSecret(authToken, masterKey);

  const config = whatsappTwilioConfigSchema.safeParse({
    type: 'whatsapp',
    provider: 'twilio',
    sender,
    accountSid,
    authTokenEncrypted,
    ...(messagingServiceSid ? { messagingServiceSid } : {}),
  });
  if (!config.success) {
    redirect(channelsUrl(org, { error: 'WhatsApp-Kanal konnte nicht angelegt werden.' }));
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('channels').insert({
    org_id: org,
    type: 'whatsapp',
    name,
    is_active: true,
    config: config.data,
  });
  if (error) {
    // The partial unique index on the Twilio sender (migration 0008) rejects a
    // number already connected in this OR another org — inbound routing is global.
    const message =
      error.code === '23505'
        ? 'Diese Nummer ist bereits als WhatsApp-Kanal verbunden.'
        : 'WhatsApp-Kanal konnte nicht angelegt werden.';
    redirect(channelsUrl(org, { error: message }));
  }

  revalidatePath('/settings/channels');
  redirect(
    channelsUrl(org, {
      notice: 'WhatsApp-Kanal (Twilio) angelegt. Bitte die Webhook-URL im Twilio-Console eintragen.',
    })
  );
}
