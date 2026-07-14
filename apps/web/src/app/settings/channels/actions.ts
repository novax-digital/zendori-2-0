'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  emailInboundConfigSchema,
  voiceChannelConfigSchema,
  whatsappTwilioConfigSchema,
} from '@zendori/channels';
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
      notice:
        'WhatsApp-Kanal (Twilio) angelegt. Bitte die Webhook-URL im Twilio-Console eintragen.',
    })
  );
}

// --- voice channel agent settings (Phase 9) --------------------------------------

const updateVoiceSettingsSchema = z.object({
  org: z.uuid(),
  channelId: z.uuid(),
  agentMode: z.enum(['answer', 'intake_only']),
  instructions: z.string().max(4000),
  greeting: z.string().max(500),
  voice: z.string().min(1).max(80),
  keyterms: z.string().max(4000),
  speechSpeed: z.coerce.number().min(0.7).max(1.5),
  transferNumber: z
    .string()
    .regex(/^\+[1-9]\d{6,15}$/)
    .or(z.literal('')),
});

/**
 * Updates the voice agent settings of an existing voice channel. The
 * provisioning fields (phoneNumber, signing secret, SIDs) are operator-managed
 * and preserved via read-modify-write; only the agent config is editable here.
 */
export async function updateVoiceChannelSettings(formData: FormData): Promise<void> {
  const errorText = 'Voice-Einstellungen konnten nicht gespeichert werden.';
  const parsed = updateVoiceSettingsSchema.safeParse({
    org: formData.get('org'),
    channelId: formData.get('channelId'),
    agentMode: formData.get('agentMode'),
    instructions: textField(formData.get('instructions')),
    greeting: textField(formData.get('greeting')),
    voice: textField(formData.get('voice')),
    keyterms: textField(formData.get('keyterms')),
    speechSpeed: textField(formData.get('speechSpeed')) || '1.0',
    transferNumber: textField(formData.get('transferNumber')),
  });
  if (!parsed.success) {
    redirect(
      channelsUrl(textField(formData.get('org')), {
        error:
          'Bitte Eingaben prüfen (Transfer-Nummer als +49…, Sprechtempo zwischen 0,7 und 1,5).',
      })
    );
  }
  const {
    org,
    channelId,
    agentMode,
    instructions,
    greeting,
    voice,
    keyterms,
    speechSpeed,
    transferNumber,
  } = parsed.data;

  const supabase = await createSupabaseServerClient();

  // Owner-only (like org_settings): transferNumber redirects live calls and
  // instructions steer the bot — too sensitive for the agent role.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: memberRow } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', org)
    .eq('user_id', user.id)
    .maybeSingle();
  if ((memberRow as { role: string } | null)?.role !== 'owner') {
    redirect(
      channelsUrl(org, { error: 'Nur Inhaber können die Voice-Einstellungen ändern.' })
    );
  }

  const { data: channelRow } = await supabase
    .from('channels')
    .select('id, type, config')
    .eq('org_id', org)
    .eq('id', channelId)
    .maybeSingle();
  const channel = channelRow as { id: string; type: string; config: unknown } | null;
  if (!channel || channel.type !== 'voice') {
    redirect(channelsUrl(org, { error: errorText }));
  }
  const existing = voiceChannelConfigSchema.safeParse(channel.config);
  if (!existing.success) {
    redirect(channelsUrl(org, { error: errorText }));
  }

  const keytermList = keyterms
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && k.length <= 50)
    .slice(0, 100);

  const overrides = {
    agentMode,
    instructions: instructions || undefined,
    greeting: greeting || undefined,
    voice,
    keyterms: keytermList,
    speechSpeed,
    transferNumber: transferNumber || undefined,
  };
  // Validate the merged shape, but PERSIST raw-config + overrides so unknown
  // keys a newer worker/provisioning version wrote are preserved (zod strips).
  const validation = voiceChannelConfigSchema.safeParse({ ...existing.data, ...overrides });
  if (!validation.success) {
    redirect(channelsUrl(org, { error: errorText }));
  }
  const nextConfig: Record<string, unknown> = {
    ...(channel.config as Record<string, unknown>),
    ...overrides,
  };
  // Explicitly clear optional fields the form emptied (spread keeps old values).
  if (!overrides.instructions) delete nextConfig.instructions;
  if (!overrides.greeting) delete nextConfig.greeting;
  if (!overrides.transferNumber) delete nextConfig.transferNumber;

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
  redirect(channelsUrl(org, { notice: 'Voice-Einstellungen gespeichert.' }));
}
