import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

type MemberRow = { org_id: string; user_id: string; role: string; created_at: string };

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  // like every settings page: honor the org switcher instead of pinning the first membership
  const { orgId, orgs } = await requireActiveOrg(org);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const supabase = await createSupabaseServerClient();

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
      <div className="page-head">
        <h1>Team</h1>
        <p>Die Mitglieder von {orgName}. Neue Zugänge legt das Zendori-Team an.</p>
      </div>

      {error ? (
        <p className="error" style={{ marginBottom: '1.5rem' }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" style={{ marginBottom: '1.5rem' }}>
          {notice}
        </p>
      ) : null}

      <div className="panel">
        <h2>Mitglieder</h2>
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
                  <span className="badge">{m.role === 'owner' ? 'Inhaber' : 'Agent'}</span>
                </td>
                <td>{new Date(m.created_at).toLocaleDateString('de-DE')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint" style={{ marginTop: '1rem' }}>
          Neue Zugänge werden vom Zendori-Team angelegt. Die öffentliche Registrierung ist
          deaktiviert.
        </p>
      </div>
    </div>
  );
}
