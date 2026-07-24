'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  buildPasswordSetupLink,
  ensureAuthUser,
  sendAddedToTeamMail,
  sendInviteMail,
} from '@/lib/team/invite';

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'org'
  );
}

function usersUrl(message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams();
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `/admin/users?${qs}` : '/admin/users';
}

function orgUrl(orgId: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams();
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `/admin/users/${orgId}?${qs}` : `/admin/users/${orgId}`;
}

// --- create a new customer (organization + owner account) ------------------------

const createCustomerSchema = z.object({
  orgName: z.string().min(2).max(120),
  email: z.email(),
});

/**
 * Creates a whole new customer: an auth user (owner, no password — the invite
 * mail carries a password-setup link), a fresh organization, and the owner
 * membership. Runs entirely with the service role — the org insert therefore
 * does NOT auto-add an owner (the trigger only does that for authenticated
 * inserts), so we assign the owner explicitly.
 */
export async function createCustomer(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const parsed = createCustomerSchema.safeParse({
    orgName: textField(formData.get('orgName')),
    email: textField(formData.get('email')),
  });
  if (!parsed.success) {
    redirect(usersUrl({ error: 'Bitte Firmenname und eine gültige E-Mail angeben.' }));
  }
  const { orgName, email } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(usersUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  // 1) create (or find) the auth user first — fail early, no orphan org
  let userId: string;
  let created: boolean;
  try {
    ({ userId, created } = await ensureAuthUser(admin, email));
  } catch {
    redirect(usersUrl({ error: 'Konto konnte nicht angelegt werden.' }));
  }

  // 2) create the organization (its org_settings row is created by the trigger)
  let orgId: string | null = null;
  const base = slugify(orgName);
  for (const slug of [base, `${base}-${userId.slice(0, 4)}`]) {
    const { data, error } = await admin
      .from('organizations')
      .insert({ name: orgName, slug })
      .select('id')
      .single();
    if (!error && data) {
      orgId = data.id as string;
      break;
    }
    if (error && error.code !== '23505') break; // non-collision error → stop retrying
  }
  if (!orgId) {
    if (created) await admin.auth.admin.deleteUser(userId); // roll back the just-created account
    redirect(usersUrl({ error: 'Organisation konnte nicht angelegt werden.' }));
  }

  // 3) assign the user as owner
  const { error: memberError } = await admin
    .from('org_members')
    .insert({ org_id: orgId, user_id: userId, role: 'owner' });
  if (memberError) {
    await admin.from('organizations').delete().eq('id', orgId); // avoid an ownerless org
    if (created) await admin.auth.admin.deleteUser(userId);
    redirect(usersUrl({ error: 'Owner konnte nicht zugewiesen werden.' }));
  }

  // 4) invitation mail (best-effort: membership stands; team page can resend)
  let mailNote = '';
  try {
    if (created) {
      const link = await buildPasswordSetupLink(admin, email);
      await sendInviteMail({ to: email, orgName, link });
    } else {
      await sendAddedToTeamMail({ to: email, orgName });
    }
  } catch (err) {
    const reason = (err instanceof Error ? err.message : 'Unbekannter Fehler').slice(0, 140);
    mailNote = ` ACHTUNG: Einladungs-E-Mail schlug fehl (${reason}).`;
  }

  revalidatePath('/admin/users');
  redirect(orgUrl(orgId, { notice: `Kunde „${orgName}" angelegt. Einladung an ${email}.${mailNote}` }));
}

// --- add a member to an existing organization ------------------------------------

const addMemberSchema = z.object({
  orgId: z.uuid(),
  email: z.email(),
  role: z.enum(['owner', 'admin', 'agent']),
});

/**
 * Adds a member to an existing org by e-mail invitation: the account is created
 * without a password (the mail carries a password-setup link); existing
 * accounts just gain the membership.
 */
export async function addMember(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const orgIdRaw = textField(formData.get('orgId'));
  const parsed = addMemberSchema.safeParse({
    orgId: orgIdRaw,
    email: textField(formData.get('email')),
    role: textField(formData.get('role')),
  });
  if (!parsed.success) {
    redirect(orgUrl(orgIdRaw, { error: 'Bitte gültige E-Mail und Rolle angeben.' }));
  }
  const { orgId, email, role } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(orgUrl(orgId, { error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { data: orgRow } = await admin
    .from('organizations')
    .select('id, name')
    .eq('id', orgId)
    .maybeSingle();
  if (!orgRow) redirect(usersUrl({ error: 'Organisation wurde nicht gefunden.' }));
  const orgName = (orgRow as { name?: string }).name ?? 'Zendori';

  let userId: string;
  let created: boolean;
  try {
    ({ userId, created } = await ensureAuthUser(admin, email));
  } catch {
    redirect(orgUrl(orgId, { error: 'Konto konnte nicht angelegt werden.' }));
  }

  const { data: existing } = await admin
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (existing) redirect(orgUrl(orgId, { error: 'Diese E-Mail-Adresse ist bereits im Team.' }));

  const { error: memberError } = await admin
    .from('org_members')
    .insert({ org_id: orgId, user_id: userId, role });
  if (memberError) {
    if (created) await admin.auth.admin.deleteUser(userId); // roll back the just-created account
    redirect(orgUrl(orgId, { error: 'Mitglied konnte nicht hinzugefügt werden.' }));
  }

  let mailNote = '';
  try {
    if (created) {
      const link = await buildPasswordSetupLink(admin, email);
      await sendInviteMail({ to: email, orgName, link });
    } else {
      await sendAddedToTeamMail({ to: email, orgName });
    }
  } catch (err) {
    const reason = (err instanceof Error ? err.message : 'Unbekannter Fehler').slice(0, 140);
    mailNote = ` ACHTUNG: Einladungs-E-Mail schlug fehl (${reason}) — nach Behebung über Einstellungen → Team erneut senden.`;
  }

  revalidatePath(`/admin/users/${orgId}`);
  redirect(orgUrl(orgId, { notice: `Mitglied hinzugefügt. Einladung an ${email}.${mailNote}` }));
}

// --- channel quotas per customer (0017) --------------------------------------------

const CHANNEL_KINDS = ['form', 'email', 'whatsapp', 'voice', 'chat', 'test'] as const;

const setLimitsSchema = z.object({ orgId: z.uuid() });

/**
 * Saves the org's channel quotas. Empty input = unlimited (row deleted);
 * a number (including 0) upserts the row. Service-role writes — the table has
 * deliberately no client write policies.
 */
export async function setChannelLimits(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const parsed = setLimitsSchema.safeParse({ orgId: textField(formData.get('orgId')) });
  if (!parsed.success) {
    redirect(usersUrl({ error: 'Organisation wurde nicht gefunden.' }));
  }
  const { orgId } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(orgUrl(orgId, { error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  // Validate ALL inputs before the first write — a mid-loop rejection must not
  // leave half the kinds already saved (audit 2026-07-21).
  const parsedLimits: { kind: (typeof CHANNEL_KINDS)[number]; value: number | null }[] = [];
  for (const kind of CHANNEL_KINDS) {
    const raw = textField(formData.get(`limit_${kind}`));
    if (raw === '') {
      parsedLimits.push({ kind, value: null });
      continue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 999) {
      redirect(
        orgUrl(orgId, { error: 'Kontingente müssen leer (unbegrenzt) oder ganze Zahlen 0–999 sein.' })
      );
    }
    parsedLimits.push({ kind, value });
  }
  for (const { kind, value } of parsedLimits) {
    const { error } =
      value === null
        ? await admin
            .from('org_channel_limits')
            .delete()
            .eq('org_id', orgId)
            .eq('channel_kind', kind)
        : await admin
            .from('org_channel_limits')
            .upsert({ org_id: orgId, channel_kind: kind, max_count: value });
    if (error) {
      redirect(orgUrl(orgId, { error: 'Kontingente konnten nicht gespeichert werden.' }));
    }
  }

  revalidatePath(`/admin/users/${orgId}`);
  redirect(orgUrl(orgId, { notice: 'Kanal-Kontingente gespeichert.' }));
}
