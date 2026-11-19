import { cache } from 'react';
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
import { getSessionUser } from '@/lib/supabase/session';

export type ActiveOrg = {
  /** The signed-in user (pages need it for "mine" filters and self checks). */
  userId: string;
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

/** The signed-in user as confirmed by the auth server (write paths). */
async function getAuthServerUser(): Promise<{ id: string } | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? { id: user.id } : null;
}

/**
 * The user's memberships, loaded once per request (React cache) — layout, page
 * and nested helpers share the result.
 */
const loadMemberships = cache(async (userId: string): Promise<MembershipRow[]> => {
  const supabase = await createSupabaseServerClient();
  // RLS shows fellow members' rows too — filter to the signed-in user.
  // permissions is 0024: retry without it while the migration is pending (42703)
  // so this hot path (every page load) can never take the whole app down.
  let { data, error } = await supabase
    .from('org_members')
    .select('org_id, role, permissions, organizations(id, name)')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error && (error as { code?: string }).code === '42703') {
    const retry = await supabase
      .from('org_members')
      .select('org_id, role, organizations(id, name)')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    data = retry.data as unknown as typeof data;
    error = retry.error;
  }
  return (data ?? []) as unknown as MembershipRow[];
});

/**
 * Loads memberships; redirects to /login (no user) or /onboarding (no org). Picks searchParam org if member, else first.
 *
 * Pages resolve the user from the locally verified access token (no auth-server
 * round trip, see getSessionUser). Server actions pass `{ strict: true }` and
 * keep asking the auth server, so a revoked session is rejected immediately on
 * every write.
 */
export async function requireActiveOrg(
  requestedOrgId?: string,
  options?: { strict?: boolean }
): Promise<ActiveOrg> {
  const user = options?.strict ? await getAuthServerUser() : await getSessionUser();
  if (!user) redirect('/login');

  const memberships = await loadMemberships(user.id);

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
    userId: user.id,
    orgId: active.org_id,
    role: active.role,
    permissions,
    access: { role: active.role, permissions },
    orgs,
  };
}
