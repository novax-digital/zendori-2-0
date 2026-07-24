'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  AREA_DEFS,
  isAdminRole,
  memberPermissionsSchema,
  type AreaKey,
  type AreaLevel,
  type MemberPermissions,
  type OrgRole,
} from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  buildPasswordSetupLink,
  ensureAuthUser,
  sendAddedToTeamMail,
  sendInviteMail,
} from '@/lib/team/invite';

// Team management (0024): owners/admins invite members by e-mail (invitee sets
// their own password via a mailed link), edit roles/permissions, and remove
// members. All writes run through the service role AFTER explicit role checks —
// the DB trigger org_members_guard_roles additionally protects owner rows on
// the direct-RLS path.

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function membersUrl(orgId: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org: orgId });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/settings/members?${params.toString()}`;
}

/** The caller must be owner/admin of the org; returns caller context + admin client. */
async function requireTeamManager(requestedOrgId: string) {
  const { orgId, role } = await requireActiveOrg(requestedOrgId);
  if (!isAdminRole(role)) {
    redirect(membersUrl(orgId, { error: 'Nur Inhaber und Admins verwalten das Team.' }));
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(membersUrl(orgId, { error: 'Service-Role ist serverseitig nicht konfiguriert.' }));
  }
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return { orgId, callerRole: role as OrgRole, callerId: user.id, admin };
}

/** Parse role + permission chips + channel scope from the member form. */
async function parseMemberForm(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  orgId: string,
  formData: FormData
): Promise<{ role: 'admin' | 'agent'; permissions: MemberPermissions } | { error: string }> {
  const role = textField(formData.get('role'));
  if (role !== 'admin' && role !== 'agent') return { error: 'Ungültige Rolle.' };
  if (role === 'admin') return { role, permissions: { areas: {}, channelIds: null } };

  const areas: Partial<Record<AreaKey, AreaLevel>> = {};
  for (const def of AREA_DEFS) {
    const value = textField(formData.get(`area_${def.key}`));
    if (value === '') continue;
    if (value !== 'view' && value !== 'edit') return { error: 'Ungültige Berechtigung.' };
    if (value === 'edit' && def.maxLevel === 'view') return { error: 'Ungültige Berechtigung.' };
    areas[def.key] = value;
  }

  let channelIds: string[] | null = null;
  if (textField(formData.get('channelScope')) === 'selected') {
    const raw = formData.getAll('channelIds').map((v) => textField(v as FormDataEntryValue));
    const ids = raw.filter((v) => z.uuid().safeParse(v).success);
    // validate against the org's channels (no cross-org ids)
    const { data } = await admin.from('channels').select('id').eq('org_id', orgId);
    const valid = new Set(((data ?? []) as { id: string }[]).map((c) => c.id));
    channelIds = ids.filter((id) => valid.has(id));
  }

  const validated = memberPermissionsSchema.safeParse({ areas, channelIds });
  if (!validated.success) return { error: 'Ungültige Berechtigungen.' };
  return { role, permissions: { areas, channelIds } };
}

// --- invite ------------------------------------------------------------------

export async function inviteMember(formData: FormData): Promise<void> {
  const orgIdRaw = textField(formData.get('org'));
  const { orgId, admin } = await requireTeamManager(orgIdRaw);

  const email = textField(formData.get('email')).toLowerCase();
  if (!z.email().safeParse(email).success) {
    redirect(membersUrl(orgId, { error: 'Bitte eine gültige E-Mail-Adresse angeben.' }));
  }

  const parsed = await parseMemberForm(admin, orgId, formData);
  if ('error' in parsed) redirect(membersUrl(orgId, { error: parsed.error }));

  const { data: orgRow } = await admin
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .maybeSingle();
  const orgName = (orgRow as { name?: string } | null)?.name ?? 'Zendori';

  let userId: string;
  let created: boolean;
  try {
    ({ userId, created } = await ensureAuthUser(admin, email));
  } catch {
    redirect(membersUrl(orgId, { error: 'Konto konnte nicht angelegt werden.' }));
  }

  // Already a member? (multi-org accounts are fine, duplicates are not)
  const { data: existing } = await admin
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (existing) {
    redirect(membersUrl(orgId, { error: 'Diese E-Mail-Adresse ist bereits im Team.' }));
  }

  const { error: memberError } = await admin.from('org_members').insert({
    org_id: orgId,
    user_id: userId,
    role: parsed.role,
    permissions: parsed.permissions,
  });
  if (memberError) {
    if (created) await admin.auth.admin.deleteUser(userId); // roll back the fresh account
    redirect(membersUrl(orgId, { error: 'Mitglied konnte nicht angelegt werden.' }));
  }

  // Mail is best-effort: the membership stands, "Einladung erneut senden" retries.
  try {
    if (created) {
      const link = await buildPasswordSetupLink(admin, email);
      await sendInviteMail({ to: email, orgName, link });
    } else {
      await sendAddedToTeamMail({ to: email, orgName });
    }
  } catch {
    redirect(
      membersUrl(orgId, {
        notice:
          'Mitglied angelegt, aber die E-Mail konnte nicht gesendet werden — bitte „Einladung erneut senden" nutzen.',
      })
    );
  }

  revalidatePath('/settings/members');
  redirect(
    membersUrl(orgId, {
      notice: created
        ? `Einladung an ${email} gesendet.`
        : `${email} wurde zum Team hinzugefügt (bestehendes Konto).`,
    })
  );
}

// --- update role/permissions -------------------------------------------------

export async function updateMember(formData: FormData): Promise<void> {
  const orgIdRaw = textField(formData.get('org'));
  const { orgId, callerRole, callerId, admin } = await requireTeamManager(orgIdRaw);

  const userId = textField(formData.get('userId'));
  if (!z.uuid().safeParse(userId).success) {
    redirect(membersUrl(orgId, { error: 'Mitglied wurde nicht gefunden.' }));
  }
  if (userId === callerId) {
    redirect(membersUrl(orgId, { error: 'Die eigene Rolle kann nicht geändert werden.' }));
  }

  const { data: targetRow } = await admin
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  const targetRole = (targetRow as { role?: OrgRole } | null)?.role;
  if (!targetRole) redirect(membersUrl(orgId, { error: 'Mitglied wurde nicht gefunden.' }));
  if (targetRole === 'owner') {
    redirect(membersUrl(orgId, { error: 'Der Inhaber kann nicht bearbeitet werden.' }));
  }
  if (targetRole === 'admin' && callerRole !== 'owner') {
    redirect(membersUrl(orgId, { error: 'Admins können nur vom Inhaber bearbeitet werden.' }));
  }

  const parsed = await parseMemberForm(admin, orgId, formData);
  if ('error' in parsed) redirect(membersUrl(orgId, { error: parsed.error }));

  const { error } = await admin
    .from('org_members')
    .update({ role: parsed.role, permissions: parsed.permissions })
    .eq('org_id', orgId)
    .eq('user_id', userId);
  if (error) redirect(membersUrl(orgId, { error: 'Änderung konnte nicht gespeichert werden.' }));

  revalidatePath('/settings/members');
  redirect(membersUrl(orgId, { notice: 'Mitglied aktualisiert.' }));
}

// --- remove ------------------------------------------------------------------

export async function removeMember(formData: FormData): Promise<void> {
  const orgIdRaw = textField(formData.get('org'));
  const { orgId, callerRole, callerId, admin } = await requireTeamManager(orgIdRaw);

  const userId = textField(formData.get('userId'));
  if (!z.uuid().safeParse(userId).success) {
    redirect(membersUrl(orgId, { error: 'Mitglied wurde nicht gefunden.' }));
  }
  if (userId === callerId) {
    redirect(membersUrl(orgId, { error: 'Du kannst dich nicht selbst entfernen.' }));
  }

  const { data: targetRow } = await admin
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  const targetRole = (targetRow as { role?: OrgRole } | null)?.role;
  if (!targetRole) redirect(membersUrl(orgId, { error: 'Mitglied wurde nicht gefunden.' }));
  if (targetRole === 'owner') {
    redirect(membersUrl(orgId, { error: 'Der Inhaber kann nicht entfernt werden.' }));
  }
  if (targetRole === 'admin' && callerRole !== 'owner') {
    redirect(membersUrl(orgId, { error: 'Admins können nur vom Inhaber entfernt werden.' }));
  }

  const { error } = await admin
    .from('org_members')
    .delete()
    .eq('org_id', orgId)
    .eq('user_id', userId);
  if (error) redirect(membersUrl(orgId, { error: 'Mitglied konnte nicht entfernt werden.' }));

  // Orphaned account cleanup: delete the auth user only when they belong to no
  // other org and are not a platform admin (multi-org accounts stay intact).
  const [{ data: otherMemberships }, { data: platformAdmin }] = await Promise.all([
    admin.from('org_members').select('org_id').eq('user_id', userId).limit(1),
    admin.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle(),
  ]);
  if ((otherMemberships ?? []).length === 0 && !platformAdmin) {
    await admin.auth.admin.deleteUser(userId);
  }

  revalidatePath('/settings/members');
  redirect(membersUrl(orgId, { notice: 'Mitglied entfernt.' }));
}

// --- resend invite -----------------------------------------------------------

export async function resendInvite(formData: FormData): Promise<void> {
  const orgIdRaw = textField(formData.get('org'));
  const { orgId, admin } = await requireTeamManager(orgIdRaw);

  const userId = textField(formData.get('userId'));
  if (!z.uuid().safeParse(userId).success) {
    redirect(membersUrl(orgId, { error: 'Mitglied wurde nicht gefunden.' }));
  }

  // Must be a member of THIS org (no arbitrary account probing).
  const { data: membership } = await admin
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!membership) redirect(membersUrl(orgId, { error: 'Mitglied wurde nicht gefunden.' }));

  const { data: userData } = await admin.auth.admin.getUserById(userId);
  const email = userData.user?.email;
  if (!email) redirect(membersUrl(orgId, { error: 'E-Mail-Adresse wurde nicht gefunden.' }));

  const { data: orgRow } = await admin
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .maybeSingle();
  const orgName = (orgRow as { name?: string } | null)?.name ?? 'Zendori';

  try {
    const link = await buildPasswordSetupLink(admin, email);
    await sendInviteMail({ to: email, orgName, link });
  } catch {
    redirect(membersUrl(orgId, { error: 'E-Mail konnte nicht gesendet werden.' }));
  }

  redirect(membersUrl(orgId, { notice: `Einladung erneut an ${email} gesendet.` }));
}
