import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

type MemberRow = { org_id: string; user_id: string; role: string; created_at: string };

export default async function MembersPage() {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // RLS shows fellow members' rows too — filter to the signed-in user
  const { data: membershipData } = await supabase
    .from('org_members')
    .select('org_id, role, organizations(id, name)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1);
  const membership = membershipData?.[0] as
    | { org_id: string; role: string; organizations: { id: string; name: string } | null }
    | undefined;
  if (!membership) redirect('/onboarding');

  const orgId = membership.org_id;

  const { data: memberData } = await supabase
    .from('org_members')
    .select('org_id, user_id, role, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  const members = (memberData ?? []) as MemberRow[];

  // resolve member emails server-side via service role (never sent to the client as key)
  const admin = createSupabaseAdminClient();
  const emailByUserId = new Map<string, string>();
  if (admin) {
    await Promise.all(
      members.map(async (m) => {
        const { data } = await admin.auth.admin.getUserById(m.user_id);
        if (data.user?.email) emailByUserId.set(m.user_id, data.user.email);
      })
    );
  }

  return (
    <div className="shell">
      <div className="panel">
        <h2>Team — {membership.organizations?.name ?? 'Organisation'}</h2>
        <table>
          <thead>
            <tr>
              <th>Mitglied</th>
              <th>Rolle</th>
              <th>Dabei seit</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id}>
                <td>{emailByUserId.get(m.user_id) ?? `${m.user_id.slice(0, 8)}…`}</td>
                <td>
                  <span className="badge">{m.role === 'owner' ? 'Owner' : 'Agent'}</span>
                </td>
                <td>{new Date(m.created_at).toLocaleDateString('de-DE')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '1rem' }}>
          Neue Zugänge werden vom Zendori-Team angelegt. Die öffentliche Registrierung ist
          deaktiviert.
        </p>
      </div>
    </div>
  );
}
