'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  defaultFormDefinition,
  formDefinitionSchema,
  formNotificationEmailsSchema,
} from '@zendori/channels';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { generatePublicToken } from '@/lib/widget/session';
import { generateIntakeAddress } from '@/lib/email/provisioning';
import { checkChannelQuota } from '@/lib/channel-limits';

// Form-builder server actions (Phase 10). Content management is member-level
// (knowledge_bases pattern) — RLS is the authority; deleting and the
// notification/limit settings are owner-only (action check + DB trigger 0019).

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function formsUrl(org: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/settings/forms?${params.toString()}`;
}

function builderUrl(org: string, formId: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/settings/forms/${formId}?${params.toString()}`;
}

async function requireOwner(org: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', org)
    .eq('user_id', user.id)
    .maybeSingle();
  const memberRole = (data as { role: string } | null)?.role;
  return memberRole === 'owner' || memberRole === 'admin';
}

// --- create -----------------------------------------------------------------------

const createFormSchema = z.object({
  org: z.uuid(),
  name: z.string().min(2).max(120),
});

export async function createForm(formData: FormData): Promise<void> {
  const parsed = createFormSchema.safeParse({
    org: formData.get('org'),
    name: textField(formData.get('name')),
  });
  if (!parsed.success) {
    redirect(formsUrl(textField(formData.get('org')), { error: 'Bitte einen Namen mit 2–120 Zeichen angeben.' }));
  }
  const { org, name } = parsed.data;

  // Builder forms share the 'form' quota kind with e-mail intake addresses
  // (product decision 2026-07-21); the 0017 trigger stays the race-safe backstop.
  const quotaError = await checkChannelQuota(org, 'form');
  if (quotaError) redirect(formsUrl(org, { error: quotaError }));

  const supabase = await createSupabaseServerClient();

  let address: string;
  try {
    address = generateIntakeAddress(name, 'webform');
  } catch {
    redirect(formsUrl(org, { error: 'E-Mail-Intake ist serverseitig nicht konfiguriert.' }));
  }

  const { data: channelRow, error: channelError } = await supabase
    .from('channels')
    .insert({
      org_id: org,
      type: 'email',
      name,
      config: {
        type: 'email',
        mode: 'inbound',
        address,
        purpose: 'form',
        builderForm: true,
      },
    })
    .select('id')
    .single();
  if (channelError || !channelRow) {
    redirect(formsUrl(org, { error: 'Formular konnte nicht angelegt werden.' }));
  }
  const channelId = (channelRow as { id: string }).id;

  const { data: formRow, error: formError } = await supabase
    .from('forms')
    .insert({
      org_id: org,
      channel_id: channelId,
      name,
      public_token: generatePublicToken(),
      definition: defaultFormDefinition(),
    })
    .select('id')
    .single();
  if (formError || !formRow) {
    // no half state: a channel without a forms row would silently occupy quota
    await supabase.from('channels').delete().eq('id', channelId).eq('org_id', org);
    redirect(formsUrl(org, { error: 'Formular konnte nicht angelegt werden.' }));
  }

  revalidatePath('/settings/forms');
  revalidatePath('/settings/channels');
  redirect(builderUrl(org, (formRow as { id: string }).id, { notice: 'Formular angelegt — jetzt Felder und Design anpassen.' }));
}

// --- save definition --------------------------------------------------------------

const saveFormSchema = z.object({
  org: z.uuid(),
  formId: z.uuid(),
  name: z.string().min(2).max(120),
  definition: z.string().max(200_000),
});

export async function saveFormDefinition(formData: FormData): Promise<void> {
  const parsed = saveFormSchema.safeParse({
    org: formData.get('org'),
    formId: formData.get('formId'),
    name: textField(formData.get('name')),
    definition: formData.get('definition'),
  });
  if (!parsed.success) {
    // back into the BUILDER when we can — a list redirect would discard the
    // unsaved builder state over e.g. a too-short name
    const rawOrg = textField(formData.get('org'));
    const rawFormId = textField(formData.get('formId'));
    const idsValid = z.uuid().safeParse(rawOrg).success && z.uuid().safeParse(rawFormId).success;
    const message = { error: 'Speichern fehlgeschlagen — bitte Name (2–120 Zeichen) und Felder prüfen.' };
    redirect(idsValid ? builderUrl(rawOrg, rawFormId, message) : formsUrl(rawOrg, message));
  }
  const { org, formId, name, definition: rawDefinition } = parsed.data;

  let definitionJson: unknown;
  try {
    definitionJson = JSON.parse(rawDefinition);
  } catch {
    redirect(builderUrl(org, formId, { error: 'Formular konnte nicht gespeichert werden.' }));
  }
  const definition = formDefinitionSchema.safeParse(definitionJson);
  if (!definition.success) {
    redirect(builderUrl(org, formId, { error: 'Die Formular-Definition ist ungültig — bitte Felder prüfen.' }));
  }

  const supabase = await createSupabaseServerClient();
  const { data: current } = await supabase
    .from('forms')
    .select('version')
    .eq('org_id', org)
    .eq('id', formId)
    .maybeSingle();
  const version = ((current as { version: number } | null)?.version ?? 0) + 1;

  const { data, error } = await supabase
    .from('forms')
    .update({
      name,
      definition: definition.data,
      version,
      updated_at: new Date().toISOString(),
    })
    .eq('org_id', org)
    .eq('id', formId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(builderUrl(org, formId, { error: 'Formular konnte nicht gespeichert werden.' }));
  }

  // keep the channel name in sync so the inbox shows the same label
  const { data: channelRef } = await supabase
    .from('forms')
    .select('channel_id')
    .eq('org_id', org)
    .eq('id', formId)
    .maybeSingle();
  const channelId = (channelRef as { channel_id: string } | null)?.channel_id;
  if (channelId) {
    await supabase.from('channels').update({ name }).eq('org_id', org).eq('id', channelId);
  }

  revalidatePath('/settings/forms');
  redirect(builderUrl(org, formId, { notice: 'Gespeichert — Änderungen sind sofort live.' }));
}

// --- notification settings (owner-only) --------------------------------------------

const notificationSettingsSchema = z.object({
  org: z.uuid(),
  formId: z.uuid(),
  emails: z.string().max(2000),
  dailyLimit: z.coerce.number().int().min(1).max(10000),
});

export async function updateFormNotificationSettings(formData: FormData): Promise<void> {
  const parsed = notificationSettingsSchema.safeParse({
    org: formData.get('org'),
    formId: formData.get('formId'),
    emails: formData.get('emails') ?? '',
    dailyLimit: textField(formData.get('dailyLimit')) || '200',
  });
  if (!parsed.success) {
    redirect(formsUrl(textField(formData.get('org')), { error: 'Einstellungen konnten nicht gespeichert werden.' }));
  }
  const { org, formId, emails, dailyLimit } = parsed.data;

  if (!(await requireOwner(org))) {
    redirect(builderUrl(org, formId, { error: 'Nur Inhaber können Weiterleitung und Limits ändern.' }));
  }

  const list = emails
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const validated = formNotificationEmailsSchema.safeParse(list);
  if (!validated.success) {
    redirect(
      builderUrl(org, formId, {
        error: 'Bitte gültige E-Mail-Adressen angeben (max. 10, eine pro Zeile).',
      })
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('forms')
    .update({ notification_emails: validated.data, daily_submission_limit: dailyLimit })
    .eq('org_id', org)
    .eq('id', formId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(builderUrl(org, formId, { error: 'Einstellungen konnten nicht gespeichert werden.' }));
  }

  revalidatePath('/settings/forms');
  redirect(builderUrl(org, formId, { notice: 'Weiterleitung gespeichert.' }));
}

// --- delete (owner-only) -----------------------------------------------------------

const deleteFormSchema = z.object({ org: z.uuid(), formId: z.uuid() });

export async function deleteForm(formData: FormData): Promise<void> {
  const parsed = deleteFormSchema.safeParse({
    org: formData.get('org'),
    formId: formData.get('formId'),
  });
  if (!parsed.success) {
    redirect(formsUrl(textField(formData.get('org')), { error: 'Formular konnte nicht gelöscht werden.' }));
  }
  const { org, formId } = parsed.data;

  if (!(await requireOwner(org))) {
    redirect(formsUrl(org, { error: 'Nur Inhaber können Formulare löschen.' }));
  }

  const supabase = await createSupabaseServerClient();
  const { data: formRow } = await supabase
    .from('forms')
    .select('channel_id')
    .eq('org_id', org)
    .eq('id', formId)
    .maybeSingle();
  const channelId = (formRow as { channel_id: string } | null)?.channel_id;
  if (!channelId) {
    redirect(formsUrl(org, { error: 'Formular wurde nicht gefunden.' }));
  }

  // Deleting the channel cascades the forms row AND the channel's
  // conversations/messages (0001 FKs) — the UI says so explicitly and asks
  // for a typed confirmation before this action is reachable.
  const { error } = await supabase.from('channels').delete().eq('org_id', org).eq('id', channelId);
  if (error) {
    redirect(formsUrl(org, { error: 'Formular konnte nicht gelöscht werden.' }));
  }

  revalidatePath('/settings/forms');
  revalidatePath('/settings/channels');
  redirect(formsUrl(org, { notice: 'Formular gelöscht.' }));
}
