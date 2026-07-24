import { redirect } from 'next/navigation';
import {
  EMPTY_PERMISSIONS,
  LEGACY_AGENT_PERMISSIONS,
  parseMemberPermissions,
  type MemberAccess,
  type MemberPermissions,
  type OrgRole,
} from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export type ActiveOrg = {
  orgId: string;
  role: OrgRole;
  /** Parsed org_members.permissions of the signed-in member (0024). */
  permissions: MemberPermissions;
  /** Convenience bundle for the canView/canEdit helpers. */
  access: MemberAccess;
  orgs: { id: string; name: string }[];
};

type MembershipRow = {
  org_id: string;
  role: OrgRole;
  permissions?: unknown;
  organizations: { id: string; name: string } | null;
};

/** Loads memberships; redirects to /login (no user) or /onboarding (no org). Picks searchParam org if member, else first. */
export async function requireActiveOrg(requestedOrgId?: string): Promise<ActiveOrg> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // RLS shows fellow members' rows too — filter to the signed-in user.
  // permissions is 0024: retry without it while the migration is pending (42703)
  // so this hot path (every page load) can never take the whole app down.
  let { data, error } = await supabase
    .from('org_members')
    .select('org_id, role, permissions, organizations(id, name)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });
  if (error && (error as { code?: string }).code === '42703') {
    const retry = await supabase
      .from('org_members')
      .select('org_id, role, organizations(id, name)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });
    data = retry.data as unknown as typeof data;
    error = retry.error;
  }
  const memberships = (data ?? []) as unknown as MembershipRow[];

  const first = memberships[0];
  if (!first) redirect('/onboarding');

  const active = memberships.find((m) => m.org_id === requestedOrgId) ?? first;
  const orgs = memberships.map((m) => ({
    id: m.org_id,
    name: m.organizations?.name ?? 'Organisation',
  }));

  // Pre-0024 skew (permissions column absent): agents keep their legacy full
  // access instead of being locked out; other roles bypass permissions anyway.
  const permissions =
    active.permissions === undefined
      ? active.role === 'agent'
        ? LEGACY_AGENT_PERMISSIONS
        : EMPTY_PERMISSIONS
      : parseMemberPermissions(active.permissions);
  return {
    orgId: active.org_id,
    role: active.role,
    permissions,
    access: { role: active.role, permissions },
    orgs,
  };
}
