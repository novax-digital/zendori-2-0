'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

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
  password: z.string().min(8).max(200),
});

/**
 * Creates a whole new customer: an auth user (owner), a fresh organization, and
 * the owner membership. Runs entirely with the service role — the org insert
 * therefore does NOT auto-add an owner (the trigger only does that for
 * authenticated inserts), so we assign the owner explicitly.
 */
export async function createCustomer(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const parsed = createCustomerSchema.safeParse({
    orgName: textField(formData.get('orgName')),
    email: textField(formData.get('email')),
    password: textField(formData.get('password')),
  });
  if (!parsed.success) {
    redirect(
      usersUrl({ error: 'Bitte Firmenname, gültige E-Mail und Passwort (min. 8 Zeichen) angeben.' })
    );
  }
  const { orgName, email, password } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(usersUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  // 1) create the auth user first — fail early on a taken e-mail (no orphan org)
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !userData.user) {
    redirect(
      usersUrl({
        error: 'Konto konnte nicht angelegt werden — die E-Mail ist evtl. bereits vergeben.',
      })
    );
  }
  const userId = userData.user.id;

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
    await admin.auth.admin.deleteUser(userId); // roll back the just-created account
    redirect(usersUrl({ error: 'Organisation konnte nicht angelegt werden.' }));
  }

  // 3) assign the user as owner
  const { error: memberError } = await admin
    .from('org_members')
    .insert({ org_id: orgId, user_id: userId, role: 'owner' });
  if (memberError) {
    await admin.from('organizations').delete().eq('id', orgId); // avoid an ownerless org
    await admin.auth.admin.deleteUser(userId);
    redirect(usersUrl({ error: 'Owner konnte nicht zugewiesen werden.' }));
  }

  revalidatePath('/admin/users');
  redirect(orgUrl(orgId, { notice: `Kunde „${orgName}" angelegt.` }));
}

// --- add a member to an existing organization ------------------------------------

const addMemberSchema = z.object({
  orgId: z.uuid(),
  email: z.email(),
  password: z.string().min(8).max(200),
  role: z.enum(['owner', 'agent']),
});

/** Creates a new auth user and adds them to an existing org with the given role. */
export async function addMember(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const orgIdRaw = textField(formData.get('orgId'));
  const parsed = addMemberSchema.safeParse({
    orgId: orgIdRaw,
    email: textField(formData.get('email')),
    password: textField(formData.get('password')),
    role: textField(formData.get('role')),
  });
  if (!parsed.success) {
    redirect(
      orgUrl(orgIdRaw, {
        error: 'Bitte gültige E-Mail, Passwort (min. 8 Zeichen) und Rolle angeben.',
      })
    );
  }
  const { orgId, email, password, role } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(orgUrl(orgId, { error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { data: orgRow } = await admin
    .from('organizations')
    .select('id')
    .eq('id', orgId)
    .maybeSingle();
  if (!orgRow) redirect(usersUrl({ error: 'Organisation wurde nicht gefunden.' }));

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !userData.user) {
    redirect(
      orgUrl(orgId, {
        error: 'Konto konnte nicht angelegt werden — die E-Mail ist evtl. bereits vergeben.',
      })
    );
  }

  const { error: memberError } = await admin
    .from('org_members')
    .insert({ org_id: orgId, user_id: userData.user.id, role });
  if (memberError) {
    await admin.auth.admin.deleteUser(userData.user.id); // roll back the just-created account
    redirect(orgUrl(orgId, { error: 'Mitglied konnte nicht hinzugefügt werden.' }));
  }

  revalidatePath(`/admin/users/${orgId}`);
  redirect(orgUrl(orgId, { notice: 'Mitglied hinzugefügt.' }));
}
