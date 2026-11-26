'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  emailInboundConfigSchema,
  normalizeWidgetTheme,
  sanitizeFontName,
  sanitizeImageUrl,
  voiceChannelConfigSchema,
  whatsappTwilioConfigSchema,
  WIDGET_AVATARS,
  WIDGET_FONT_SIZES,
  WIDGET_FONTS,
  WIDGET_LAUNCHER_ICONS,
  WIDGET_LAUNCHERS,
  WIDGET_LIMITS,
  WIDGET_POSITIONS,
  WIDGET_RADII,
  WIDGET_SCHEMES,
} from '@zendori/channels';
import { encryptSecret, type Channel } from '@zendori/core';
import { channelFeeOf, formatChannelFee, loadChannelFees } from '@/lib/channel-fees';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { DEFAULT_THEME, generatePublicToken } from '@/lib/widget/session';
import { generateIntakeAddress } from '@/lib/email/provisioning';
import { channelKindOf, checkChannelQuota } from '@/lib/channel-limits';

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function channelsUrl(
  org: string,
  message?: { error?: string; notice?: string },
  returnTo?: string | null
): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  // two-level layout (2026-07-24): actions invoked from a channel detail page
  // return there. Strictly validated same-section path — never an open redirect.
  // Redesign: the detail page has page tabs (?tab=…); returnToOf() appends the
  // tab the form was on, so a save lands on the same tab again.
  // A builder form's channel page is /settings/forms/[formId] (its agent and
  // status rows post to the channel actions), so that path is accepted too.
  let base = '/settings/channels';
  if (returnTo) {
    const [path, query] = returnTo.split('?');
    if (path && /^\/settings\/(channels|forms)\/[0-9a-f-]{36}$/.test(path)) {
      base = path;
      const tab = new URLSearchParams(query ?? '').get('tab');
      if (tab && /^[a-z]{1,16}$/.test(tab)) params.set('tab', tab);
    }
  }
  return `${base}?${params.toString()}`;
}

/** Reads the optional detail-page return target (plus its page tab) from the form. */
function returnToOf(formData: FormData): string | null {
  const value = formData.get('returnTo');
  if (typeof value !== 'string') return null;
  const tab = formData.get('tab');
  return typeof tab === 'string' && tab !== '' ? `${value}?tab=${tab}` : value;
}

/** Channel types offered in the "Neuer Kanal" drawer of the list page. */
const DRAWER_TYPES = new Set(['email', 'form', 'webform', 'chat', 'whatsapp', 'voice', 'test']);

/**
 * Error target of the create actions. The create forms live in the "Neuer
 * Kanal" drawer (?panel=new&type=…) and send their type as `drawerType`; an
 * error returns into that drawer so the user can correct and resubmit. Without
 * a (valid) drawerType this is the plain list URL, as before.
 */
function createErrorUrl(formData: FormData, org: string, error: string): string {
  const params = new URLSearchParams({ org, error });
  const type = textField(formData.get('drawerType'));
  if (DRAWER_TYPES.has(type)) {
    params.set('panel', 'new');
    params.set('type', type);
  }
  return `/settings/channels?${params.toString()}`;
}

// --- channels that cost a monthly fee (migration 0045) ----------------------------
// The fee per channel is charged for ACTIVE channels only. A channel of a kind
// that costs this customer something is therefore created as a draft
// (inactive): it can be set up in peace, and the fee starts with a deliberate
// "Kostenpflichtig aktivieren". Free kinds are active at once, as before.

/** Notice after creating a channel: what was created, and — for a draft — what activating costs. */
function createdNotice(what: string, feeEur: number, extra = ''): string {
  return feeEur > 0
    ? `${what} als Entwurf angelegt. Aktiv kostet der Kanal ${formatChannelFee(feeEur)} pro Monat — er startet erst, wenn du ihn aktivierst.${extra}`
    : `${what} angelegt.${extra}`;
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
      createErrorUrl(
        formData,
        textField(formData.get('org')),
        'Bitte einen Namen mit 2–80 Zeichen angeben.'
      )
    );
  }
  const { org, name } = parsed.data;

  // Quota pre-check (0017; the DB trigger is the race-safe backstop).
  const quotaError = await checkChannelQuota(org, 'chat');
  if (quotaError) redirect(createErrorUrl(formData, org, quotaError));

  const feeEur = channelFeeOf(await loadChannelFees(org), 'chat');

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('channels').insert({
    org_id: org,
    type: 'chat',
    name,
    // a paid kind starts as a draft (0045)
    is_active: feeEur <= 0,
    config: {
      widget: true,
      public_token: generatePublicToken(),
      theme: DEFAULT_THEME,
      // ticket separation default for NEW widgets: next day = new conversation
      conversation_split_hours: 24,
    },
  });
  if (error) {
    redirect(createErrorUrl(formData, org, 'Widget-Channel konnte nicht angelegt werden.'));
  }

  revalidatePath('/settings/channels');
  redirect(channelsUrl(org, { notice: createdNotice('Widget-Channel', feeEur) }));
}

// --- update widget theme ---------------------------------------------------------

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Bitte eine Farbe als Hex-Wert wählen (z. B. #4f46e5).');

/**
 * The designer's form (components/WidgetDesigner.tsx). Strict here so a typo
 * gets a message instead of silently falling back; the stored theme is then
 * normalized once more (normalizeWidgetTheme) — the single source of truth
 * for bounds and defaults.
 */
const updateWidgetThemeSchema = z
  .object({
    org: z.uuid(),
    channelId: z.uuid(),
    title: z.string().trim().min(1, 'Bitte einen Titel angeben.').max(WIDGET_LIMITS.title),
    subtitle: z.string().trim().max(WIDGET_LIMITS.subtitle),
    greeting: z.string().trim().max(WIDGET_LIMITS.greeting),
    placeholder: z.string().trim().max(WIDGET_LIMITS.placeholder),
    quickReplies: z.array(z.string().trim().max(WIDGET_LIMITS.quickReply)).max(WIDGET_LIMITS.quickReplies),
    color: hexColor,
    gradient: z.boolean(),
    color2: hexColor,
    scheme: z.enum(WIDGET_SCHEMES),
    font: z.enum(WIDGET_FONTS),
    customFont: z.string().trim().max(WIDGET_LIMITS.customFont),
    fontSize: z.enum(WIDGET_FONT_SIZES),
    radius: z.enum(WIDGET_RADII),
    position: z.enum(WIDGET_POSITIONS),
    offsetX: z.coerce.number().int().min(WIDGET_LIMITS.offsetMin).max(WIDGET_LIMITS.offsetMax),
    offsetY: z.coerce.number().int().min(WIDGET_LIMITS.offsetMin).max(WIDGET_LIMITS.offsetMax),
    launcher: z.enum(WIDGET_LAUNCHERS),
    launcherLabel: z.string().trim().max(WIDGET_LIMITS.launcherLabel),
    launcherIcon: z.enum(WIDGET_LAUNCHER_ICONS),
    teaser: z.boolean(),
    teaserText: z.string().trim().max(WIDGET_LIMITS.teaserText),
    avatar: z.enum(WIDGET_AVATARS),
    avatarUrl: z.string().trim().max(WIDGET_LIMITS.avatarUrl),
    branding: z.boolean(),
  })
  .superRefine((theme, ctx) => {
    if (theme.font === 'custom' && !sanitizeFontName(theme.customFont)) {
      ctx.addIssue({ code: 'custom', message: 'Bitte den Namen der eigenen Schrift angeben.' });
    }
    if (theme.avatar === 'image' && !sanitizeImageUrl(theme.avatarUrl)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Bitte für das Bild eine Adresse angeben, die mit https:// beginnt.',
      });
    }
    if (theme.launcher === 'label' && !theme.launcherLabel) {
      ctx.addIssue({ code: 'custom', message: 'Bitte einen Text für den Chat-Button angeben.' });
    }
    if (theme.teaser && !theme.teaserText) {
      ctx.addIssue({ code: 'custom', message: 'Bitte einen Text für den Hinweis angeben.' });
    }
  });

export async function updateWidgetTheme(formData: FormData): Promise<void> {
  const errorText = 'Das Design konnte nicht gespeichert werden.';
  const parsed = updateWidgetThemeSchema.safeParse({
    org: formData.get('org'),
    channelId: formData.get('channelId'),
    title: textField(formData.get('title')),
    subtitle: textField(formData.get('subtitle')),
    greeting: textField(formData.get('greeting')),
    placeholder: textField(formData.get('placeholder')),
    quickReplies: formData
      .getAll('quickReply')
      .map((value) => textField(value).trim())
      .filter((value) => value.length > 0),
    color: textField(formData.get('color')),
    gradient: formData.get('gradient') === 'on',
    color2: textField(formData.get('color2')),
    scheme: textField(formData.get('scheme')),
    font: textField(formData.get('font')),
    customFont: textField(formData.get('customFont')),
    fontSize: textField(formData.get('fontSize')),
    radius: textField(formData.get('radius')),
    position: textField(formData.get('position')),
    offsetX: textField(formData.get('offsetX')),
    offsetY: textField(formData.get('offsetY')),
    launcher: textField(formData.get('launcher')),
    launcherLabel: textField(formData.get('launcherLabel')),
    launcherIcon: textField(formData.get('launcherIcon')),
    teaser: formData.get('teaser') === 'on',
    teaserText: textField(formData.get('teaserText')),
    avatar: textField(formData.get('avatar')),
    avatarUrl: textField(formData.get('avatarUrl')),
    branding: formData.get('branding') === 'on',
  });
  if (!parsed.success) {
    // the first problem in plain words; field-level limits are also enforced in the form
    const first = parsed.error.issues[0];
    const message =
      first && first.message && !/^(Invalid|Too|Expected)/.test(first.message)
        ? first.message
        : 'Bitte prüf die Angaben im Design (Texte, Farben und Abstände).';
    redirect(channelsUrl(textField(formData.get('org')), { error: message }, returnToOf(formData)));
  }
  const { org, channelId, ...themeInput } = parsed.data;
  const theme = normalizeWidgetTheme(themeInput);

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
    redirect(channelsUrl(org, { error: errorText }, returnToOf(formData)));
  }

  const nextConfig = { ...channel.config, theme };
  const { data, error } = await supabase
    .from('channels')
    .update({ config: nextConfig })
    .eq('org_id', org)
    .eq('id', channelId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(channelsUrl(org, { error: errorText }, returnToOf(formData)));
  }

  revalidatePath('/settings/channels');
  redirect(channelsUrl(org, { notice: 'Design gespeichert.' }, returnToOf(formData)));
}

// --- create e-mail intake address ------------------------------------------------

const createIntakeAddressSchema = z.object({
  org: z.uuid(),
  name: z.string().min(2).max(120),
  slugPart: z.string().min(1).max(40),
  purpose: z.enum(['form', 'forwarded_email']),
});

/**
 * Provisions a generated, non-guessable inbound e-mail address and creates the
 * matching email/inbound channel. Mails sent to that address (as recipient or
 * CC) reach this org's inbox via the Resend webhook. `purpose` distinguishes a
 * website contact-form intake from a forwarded-mailbox intake (Phase 8).
 */
export async function createIntakeAddress(formData: FormData): Promise<void> {
  const parsed = createIntakeAddressSchema.safeParse({
    org: formData.get('org'),
    name: textField(formData.get('name')),
    slugPart: textField(formData.get('slugPart')),
    purpose: textField(formData.get('purpose')),
  });
  if (!parsed.success) {
    redirect(
      createErrorUrl(
        formData,
        textField(formData.get('org')),
        'Bitte einen Namen (2–120 Zeichen) und ein Kürzel (z. B. „kf") angeben.'
      )
    );
  }
  const { org, name, slugPart, purpose } = parsed.data;

  // Quota pre-check: 'form' and 'email' (forwarded) count separately (0017).
  const quotaError = await checkChannelQuota(org, purpose === 'form' ? 'form' : 'email');
  if (quotaError) redirect(createErrorUrl(formData, org, quotaError));

  const supabase = await createSupabaseServerClient();

  // the org slug seeds the readable local part of the intake address
  const { data: orgRow } = await supabase
    .from('organizations')
    .select('slug')
    .eq('id', org)
    .maybeSingle();
  const slug = (orgRow as { slug: string } | null)?.slug;
  if (!slug) {
    redirect(createErrorUrl(formData, org, 'Organisation wurde nicht gefunden.'));
  }

  const address = generateIntakeAddress(slug, slugPart);
  // Validate the channel config against the shared schema before persisting.
  const config = emailInboundConfigSchema.safeParse({
    type: 'email',
    mode: 'inbound',
    address,
    purpose,
  });
  if (!config.success) {
    redirect(createErrorUrl(formData, org, 'Intake-Adresse konnte nicht angelegt werden.'));
  }
  const feeEur = channelFeeOf(await loadChannelFees(org), purpose === 'form' ? 'form' : 'email');
  const { error } = await supabase.from('channels').insert({
    org_id: org,
    type: 'email',
    name,
    // a paid kind starts as a draft (0045)
    is_active: feeEur <= 0,
    config: config.data,
  });
  if (error) {
    redirect(createErrorUrl(formData, org, 'Intake-Adresse konnte nicht angelegt werden.'));
  }

  revalidatePath('/settings/channels');
  redirect(
    channelsUrl(org, {
      notice: createdNotice(purpose === 'form' ? 'Formular-Adresse' : 'E-Mail-Adresse', feeEur),
    })
  );
}

// --- assign an agent to a channel -------------------------------------------------

const setChannelAgentSchema = z.object({
  org: z.uuid(),
  channelId: z.uuid(),
  /** Empty string = detach (no agent → no drafts, no auto-sends). */
  agentId: z.uuid().or(z.literal('')),
});

/**
 * Assigns/detaches the channel's AI agent (0011). Owner-only: the assignment
 * changes live bot behavior (channels RLS is member-level, so this explicit
 * check is load-bearing). The composite FK rejects cross-org agents.
 */
export async function setChannelAgent(formData: FormData): Promise<void> {
  const parsed = setChannelAgentSchema.safeParse({
    org: formData.get('org'),
    channelId: formData.get('channelId'),
    agentId: textField(formData.get('agentId')),
  });
  if (!parsed.success) {
    redirect(
      channelsUrl(textField(formData.get('org')), {
        error: 'Agent-Zuweisung konnte nicht gespeichert werden.',
      }, returnToOf(formData))
    );
  }
  const { org, channelId, agentId } = parsed.data;

  const supabase = await createSupabaseServerClient();
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
  const memberRole = (memberRow as { role: string } | null)?.role;
  if (memberRole !== 'owner' && memberRole !== 'admin') {
    redirect(channelsUrl(org, { error: 'Nur Inhaber und Admins können den Agenten eines Kanals ändern.' }, returnToOf(formData)));
  }

  const { data, error } = await supabase
    .from('channels')
    .update({ agent_id: agentId === '' ? null : agentId })
    .eq('org_id', org)
    .eq('id', channelId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(channelsUrl(org, { error: 'Agent-Zuweisung konnte nicht gespeichert werden.' }, returnToOf(formData)));
  }

  revalidatePath('/settings/channels');
  revalidatePath('/settings/agents');
  redirect(
    channelsUrl(org, {
      notice: agentId === '' ? 'Agent entfernt — Kanal läuft ohne KI-Antworten.' : 'Agent zugewiesen.',
    }, returnToOf(formData))
  );
}

// --- ticket separation: inactivity window per channel -----------------------------

const updateConversationSplitSchema = z.object({
  org: z.uuid(),
  channelId: z.uuid(),
  /** '' = never split; otherwise hours (UI offers 24 / 72 / 168). */
  splitHours: z
    .literal('')
    .or(z.coerce.number().int().min(1).max(8760))
    .transform((v) => (v === '' ? null : v)),
});

/**
 * Sets "Neue Unterhaltung nach Inaktivität" on a WhatsApp or widget channel.
 * Owner-only (channel mechanics, like the voice settings). The value lives in
 * channels.config — camelCase `conversationSplitHours` for WhatsApp (schema in
 * packages/channels), snake_case `conversation_split_hours` for the widget
 * (schema in lib/widget/session.ts).
 */
export async function updateConversationSplit(formData: FormData): Promise<void> {
  const errorText = 'Einstellung konnte nicht gespeichert werden.';
  const parsed = updateConversationSplitSchema.safeParse({
    org: formData.get('org'),
    channelId: formData.get('channelId'),
    splitHours: textField(formData.get('splitHours')),
  });
  if (!parsed.success) {
    redirect(channelsUrl(textField(formData.get('org')), { error: errorText }, returnToOf(formData)));
  }
  const { org, channelId, splitHours } = parsed.data;

  const supabase = await createSupabaseServerClient();
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
  const memberRole = (memberRow as { role: string } | null)?.role;
  if (memberRole !== 'owner' && memberRole !== 'admin') {
    redirect(channelsUrl(org, { error: 'Nur Inhaber und Admins können diese Einstellung ändern.' }, returnToOf(formData)));
  }

  const { data: channelRow } = await supabase
    .from('channels')
    .select('id, type, config')
    .eq('org_id', org)
    .eq('id', channelId)
    .maybeSingle();
  const channel = channelRow as {
    id: string;
    type: string;
    config: Record<string, unknown>;
  } | null;
  const isWhatsapp = channel?.type === 'whatsapp';
  const isWidget = channel?.type === 'chat' && channel.config['widget'] === true;
  if (!channel || (!isWhatsapp && !isWidget)) {
    redirect(channelsUrl(org, { error: errorText }, returnToOf(formData)));
  }

  const key = isWhatsapp ? 'conversationSplitHours' : 'conversation_split_hours';
  const nextConfig: Record<string, unknown> = { ...channel.config };
  if (splitHours === null) delete nextConfig[key];
  else nextConfig[key] = splitHours;

  const { data, error } = await supabase
    .from('channels')
    .update({ config: nextConfig })
    .eq('org_id', org)
    .eq('id', channelId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(channelsUrl(org, { error: errorText }, returnToOf(formData)));
  }

  revalidatePath('/settings/channels');
  redirect(
    channelsUrl(org, {
      notice:
        splitHours === null
          ? 'Ticket-Trennung deaktiviert — Nachrichten laufen in der bestehenden Unterhaltung weiter.'
          : 'Ticket-Trennung gespeichert.',
    }, returnToOf(formData))
  );
}

// --- activate / deactivate a channel ---------------------------------------------

const setChannelActiveSchema = z.object({
  org: z.uuid(),
  channelId: z.uuid(),
  active: z.enum(['true', 'false']),
});

/**
 * Flips a single channel's is_active flag. Used by the per-channel Aktiv/Inaktiv
 * toggle in the channel gallery. RLS ensures the caller may only touch channels
 * of an org they belong to.
 *
 * Activating a channel whose kind costs a monthly fee (0045) needs the explicit
 * confirmation of the toggle (`confirmFee`): the fee is charged for every month
 * the channel is active, so it must never start by a slip or a stale form.
 */
export async function setChannelActive(formData: FormData): Promise<void> {
  const parsed = setChannelActiveSchema.safeParse({
    org: formData.get('org'),
    channelId: formData.get('channelId'),
    active: formData.get('active'),
  });
  if (!parsed.success) {
    redirect(
      channelsUrl(textField(formData.get('org')), {
        error: 'Kanal-Status konnte nicht geändert werden.',
      }, returnToOf(formData))
    );
  }
  const { org, channelId, active } = parsed.data;
  const isActive = active === 'true';
  const back = (message: { error?: string; notice?: string }): string =>
    channelsUrl(org, message, returnToOf(formData));

  const supabase = await createSupabaseServerClient();

  // what this channel costs while it is active (the member's own session reads
  // the channel, so RLS decides whether it exists for the caller at all)
  let feeEur = 0;
  if (isActive) {
    const { data: current } = await supabase
      .from('channels')
      .select('type, config, is_active')
      .eq('org_id', org)
      .eq('id', channelId)
      .maybeSingle();
    if (!current) redirect(back({ error: 'Kanal-Status konnte nicht geändert werden.' }));
    const row = current as Pick<Channel, 'type' | 'config'> & { is_active: boolean };
    feeEur = channelFeeOf(await loadChannelFees(org), channelKindOf(row));
    if (feeEur > 0 && !row.is_active && formData.get('confirmFee') !== '1') {
      redirect(
        back({
          error: `Aktiv kostet dieser Kanal ${formatChannelFee(feeEur)} pro Monat. Bitte bestätige das Aktivieren am Schalter.`,
        })
      );
    }
  }

  const { data, error } = await supabase
    .from('channels')
    .update({ is_active: isActive })
    .eq('org_id', org)
    .eq('id', channelId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(back({ error: 'Kanal-Status konnte nicht geändert werden.' }));
  }

  revalidatePath('/settings/channels');
  redirect(
    back({
      notice: isActive
        ? feeEur > 0
          ? `Kanal aktiviert. Er kostet ${formatChannelFee(feeEur)} pro Monat, solange er aktiv ist.`
          : 'Kanal aktiviert.'
        : 'Kanal deaktiviert. Er empfängt jetzt nichts mehr.',
    })
  );
}

// --- rename a channel ------------------------------------------------------------

const renameChannelSchema = z.object({
  org: z.uuid(),
  channelId: z.uuid(),
  name: z.string().trim().min(2).max(120),
});

/**
 * Renames a channel. The name is a pure label — it identifies the channel in the
 * inbox and the channel list and is never part of routing (that goes by intake
 * address, phone number or public token), so renaming is always safe and never
 * touches a live integration.
 *
 * Same access shape as the other per-channel controls (setChannelActive): RLS
 * proves org membership, and the agent assignment stays the only owner-gated
 * field on the row.
 */
export async function renameChannel(formData: FormData): Promise<void> {
  const parsed = renameChannelSchema.safeParse({
    org: formData.get('org'),
    channelId: formData.get('channelId'),
    name: formData.get('name'),
  });
  if (!parsed.success) {
    redirect(
      channelsUrl(
        textField(formData.get('org')),
        { error: 'Bitte einen Namen mit 2 bis 120 Zeichen angeben.' },
        returnToOf(formData)
      )
    );
  }
  const { org, channelId, name } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('channels')
    .update({ name })
    .eq('org_id', org)
    .eq('id', channelId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(
      channelsUrl(org, { error: 'Kanal konnte nicht umbenannt werden.' }, returnToOf(formData))
    );
  }

  revalidatePath('/settings/channels');
  revalidatePath(`/settings/channels/${channelId}`);
  // The inbox shows the channel name on every conversation.
  revalidatePath('/inbox');
  redirect(channelsUrl(org, { notice: 'Kanal umbenannt.' }, returnToOf(formData)));
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
      createErrorUrl(
        formData,
        textField(formData.get('org')),
        'Bitte Nummer (+49…), Account SID (AC…), Auth Token und optional Messaging Service SID (MG…) angeben.'
      )
    );
  }
  const { org, name, sender, accountSid, authToken, messagingServiceSid } = parsed.data;

  const quotaError = await checkChannelQuota(org, 'whatsapp');
  if (quotaError) redirect(createErrorUrl(formData, org, quotaError));

  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  if (!masterKey) {
    redirect(createErrorUrl(formData, org, 'Verschlüsselung ist serverseitig nicht konfiguriert.'));
  }
  const authTokenEncrypted = await encryptSecret(authToken, masterKey);

  const config = whatsappTwilioConfigSchema.safeParse({
    type: 'whatsapp',
    provider: 'twilio',
    sender,
    accountSid,
    authTokenEncrypted,
    ...(messagingServiceSid ? { messagingServiceSid } : {}),
    // ticket separation default for NEW channels: 3 days of silence = new ticket
    conversationSplitHours: 72,
  });
  if (!config.success) {
    redirect(createErrorUrl(formData, org, 'WhatsApp-Kanal konnte nicht angelegt werden.'));
  }

  const feeEur = channelFeeOf(await loadChannelFees(org), 'whatsapp');

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('channels').insert({
    org_id: org,
    type: 'whatsapp',
    name,
    // a paid kind starts as a draft (0045)
    is_active: feeEur <= 0,
    config: config.data,
  });
  if (error) {
    // The partial unique index on the Twilio sender (migration 0008) rejects a
    // number already connected in this OR another org — inbound routing is global.
    const message =
      error.code === '23505'
        ? 'Diese Nummer ist bereits als WhatsApp-Kanal verbunden.'
        : 'WhatsApp-Kanal konnte nicht angelegt werden.';
    redirect(createErrorUrl(formData, org, message));
  }

  revalidatePath('/settings/channels');
  redirect(
    channelsUrl(org, {
      notice: createdNotice(
        'WhatsApp-Kanal (Twilio)',
        feeEur,
        ' Bitte die Webhook-URL im Twilio-Console eintragen.'
      ),
    })
  );
}

// --- voice channel agent settings (Phase 9) --------------------------------------

const updateVoiceSettingsSchema = z.object({
  org: z.uuid(),
  channelId: z.uuid(),
  greeting: z.string().max(500),
  greetingInterruptible: z.boolean(),
  farewell: z.string().max(500),
  voice: z.string().min(1).max(80),
  /** Conversation + ASR language (UI offers a fixed list; schema keeps BCP-47ish). */
  languageHint: z.string().regex(/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/),
  keyterms: z.string().max(4000),
  speechSpeed: z.coerce.number().min(0.7).max(1.5),
  transferNumber: z
    .string()
    .regex(/^\+[1-9]\d{6,15}$/)
    .or(z.literal('')),
  recordingEnabled: z.boolean(),
});

/**
 * Updates the voice-technical settings of an existing voice channel. The
 * provisioning fields (phoneNumber, signing secret, SIDs) are operator-managed
 * and preserved via read-modify-write. Behavioral config (mode/identity) lives
 * on the assigned agent (0011) — edited under settings/agents.
 */
export async function updateVoiceChannelSettings(formData: FormData): Promise<void> {
  const errorText = 'Voice-Einstellungen konnten nicht gespeichert werden.';
  const parsed = updateVoiceSettingsSchema.safeParse({
    org: formData.get('org'),
    channelId: formData.get('channelId'),
    greeting: textField(formData.get('greeting')),
    greetingInterruptible: formData.get('greetingInterruptible') === 'on',
    farewell: textField(formData.get('farewell')),
    voice: textField(formData.get('voice')),
    languageHint: textField(formData.get('languageHint')) || 'de',
    keyterms: textField(formData.get('keyterms')),
    speechSpeed: textField(formData.get('speechSpeed')) || '1.0',
    transferNumber: textField(formData.get('transferNumber')),
    recordingEnabled: formData.get('recordingEnabled') === 'on',
  });
  if (!parsed.success) {
    redirect(
      channelsUrl(textField(formData.get('org')), {
        error:
          'Bitte Eingaben prüfen (Transfer-Nummer als +49…, Sprechtempo zwischen 0,7 und 1,5).',
      }, returnToOf(formData))
    );
  }
  const {
    org,
    channelId,
    greeting,
    greetingInterruptible,
    farewell,
    voice,
    languageHint,
    keyterms,
    speechSpeed,
    transferNumber,
    recordingEnabled,
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
  const memberRole = (memberRow as { role: string } | null)?.role;
  if (memberRole !== 'owner' && memberRole !== 'admin') {
    redirect(
      channelsUrl(org, { error: 'Nur Inhaber und Admins können die Voice-Einstellungen ändern.' }, returnToOf(formData))
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
    redirect(channelsUrl(org, { error: errorText }, returnToOf(formData)));
  }
  const existing = voiceChannelConfigSchema.safeParse(channel.config);
  if (!existing.success) {
    redirect(channelsUrl(org, { error: errorText }, returnToOf(formData)));
  }

  const keytermList = keyterms
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && k.length <= 50)
    .slice(0, 100);

  const overrides = {
    greeting: greeting || undefined,
    greetingInterruptible,
    farewell: farewell || undefined,
    voice,
    languageHint,
    keyterms: keytermList,
    speechSpeed,
    transferNumber: transferNumber || undefined,
    recordingEnabled,
  };
  // Validate the merged shape, but PERSIST raw-config + overrides so unknown
  // keys a newer worker/provisioning version wrote are preserved (zod strips).
  const validation = voiceChannelConfigSchema.safeParse({ ...existing.data, ...overrides });
  if (!validation.success) {
    redirect(channelsUrl(org, { error: errorText }, returnToOf(formData)));
  }
  const nextConfig: Record<string, unknown> = {
    ...(channel.config as Record<string, unknown>),
    ...overrides,
  };
  // Explicitly clear optional fields the form emptied (spread keeps old values),
  // and drop the pre-0011 behavioral keys — they live on the agent now.
  if (!overrides.greeting) delete nextConfig.greeting;
  if (!overrides.farewell) delete nextConfig.farewell;
  if (!overrides.transferNumber) delete nextConfig.transferNumber;
  delete nextConfig.agentMode;
  delete nextConfig.instructions;

  const { data, error } = await supabase
    .from('channels')
    .update({ config: nextConfig })
    .eq('org_id', org)
    .eq('id', channelId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(channelsUrl(org, { error: errorText }, returnToOf(formData)));
  }

  revalidatePath('/settings/channels');
  redirect(channelsUrl(org, { notice: 'Voice-Einstellungen gespeichert.' }, returnToOf(formData)));
}

// --- delete a channel (owner 2026-07-24) -------------------------------------------

const deleteChannelSchema = z.object({ org: z.uuid(), channelId: z.uuid() });

/**
 * Deletes a channel — CASCADES all of its conversations/messages (FK design).
 * Owner/admin only (app-level gate like every channel mutation; the DB guard
 * additionally protects form-builder channels). Builder-form channels are
 * deleted in the form builder instead (name-confirmation flow there).
 */
export async function deleteChannel(formData: FormData): Promise<void> {
  const parsed = deleteChannelSchema.safeParse({
    org: formData.get('org'),
    channelId: formData.get('channelId'),
  });
  if (!parsed.success) {
    redirect(channelsUrl(textField(formData.get('org')), { error: 'Kanal wurde nicht gefunden.' }));
  }
  const { org, channelId } = parsed.data;
  const detailReturn = `/settings/channels/${channelId}`;

  const supabase = await createSupabaseServerClient();
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
  const memberRole = (memberRow as { role: string } | null)?.role;
  if (memberRole !== 'owner' && memberRole !== 'admin') {
    redirect(channelsUrl(org, { error: 'Nur Inhaber und Admins können Kanäle löschen.' }, detailReturn));
  }

  const { data: channelRow } = await supabase
    .from('channels')
    .select('name, config')
    .eq('org_id', org)
    .eq('id', channelId)
    .maybeSingle();
  if (!channelRow) redirect(channelsUrl(org, { error: 'Kanal wurde nicht gefunden.' }));
  const config = (channelRow as { config?: Record<string, unknown> }).config ?? {};
  if (config.builderForm === true) {
    redirect(
      channelsUrl(
        org,
        { error: 'Ein Formular löschst du auf seiner eigenen Seite (Menü oben rechts).' },
        detailReturn
      )
    );
  }

  const { data: deleted, error } = await supabase
    .from('channels')
    .delete()
    .eq('org_id', org)
    .eq('id', channelId)
    .select('id');
  if (error || !deleted || deleted.length === 0) {
    redirect(channelsUrl(org, { error: 'Kanal konnte nicht gelöscht werden.' }, detailReturn));
  }

  revalidatePath('/settings/channels');
  redirect(
    channelsUrl(org, {
      notice: `Kanal „${(channelRow as { name: string }).name}" samt Konversationen gelöscht.`,
    })
  );
}

