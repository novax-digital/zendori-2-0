'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isAdminRole } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function orgUrl(orgId: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org: orgId });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/settings/organization?${params.toString()}`;
}

const renameSchema = z.object({
  org: z.uuid(),
  name: z.string().min(2).max(120),
});

/**
 * Rename the organization (owner/admin). Uses the user-scoped client — the
 * organizations_update RLS policy (is_org_owner = owner|admin since 0024) is
 * the authoritative gate; the slug stays unchanged (it is baked into existing
 * intake addresses and must not drift).
 */
export async function updateOrganizationName(formData: FormData): Promise<void> {
  const raw = typeof formData.get('org') === 'string' ? (formData.get('org') as string) : '';
  const { orgId, role } = await requireActiveOrg(raw);
  if (!isAdminRole(role)) {
    redirect(orgUrl(orgId, { error: 'Nur Inhaber und Admins können die Organisation ändern.' }));
  }

  const parsed = renameSchema.safeParse({
    org: orgId,
    name: typeof formData.get('name') === 'string' ? (formData.get('name') as string).trim() : '',
  });
  if (!parsed.success) {
    redirect(orgUrl(orgId, { error: 'Der Name muss 2–120 Zeichen lang sein.' }));
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('organizations')
    .update({ name: parsed.data.name })
    .eq('id', orgId);
  if (error) redirect(orgUrl(orgId, { error: 'Name konnte nicht gespeichert werden.' }));

  revalidatePath('/settings/organization');
  redirect(orgUrl(orgId, { notice: 'Organisationsname gespeichert.' }));
}
