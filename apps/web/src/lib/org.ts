import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export type ActiveOrg = {
  orgId: string;
  role: 'owner' | 'agent';
  orgs: { id: string; name: string }[];
};

type MembershipRow = {
  org_id: string;
  role: 'owner' | 'agent';
  organizations: { id: string; name: string } | null;
};

/** Loads memberships; redirects to /login (no user) or /onboarding (no org). Picks searchParam org if member, else first. */
export async function requireActiveOrg(requestedOrgId?: string): Promise<ActiveOrg> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // RLS shows fellow members' rows too — filter to the signed-in user
  const { data } = await supabase
    .from('org_members')
    .select('org_id, role, organizations(id, name)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });
  const memberships = (data ?? []) as unknown as MembershipRow[];

  const first = memberships[0];
  if (!first) redirect('/onboarding');

  const active = memberships.find((m) => m.org_id === requestedOrgId) ?? first;
  const orgs = memberships.map((m) => ({
    id: m.org_id,
    name: m.organizations?.name ?? 'Organisation',
  }));

  return { orgId: active.org_id, role: active.role, orgs };
}
