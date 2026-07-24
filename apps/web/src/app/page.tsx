import Link from 'next/link';
import { redirect } from 'next/navigation';
import { signOut } from './actions';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type Membership = {
  role: string;
  organizations: { id: string; name: string; slug: string } | null;
};

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // RLS shows fellow members' rows too — filter to the signed-in user
  const { data } = await supabase
    .from('org_members')
    .select('role, organizations(id, name, slug)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });
  const memberships = (data ?? []) as unknown as Membership[];

  if (memberships.length === 0) redirect('/onboarding');
  // one org (the normal case): straight into the app instead of a chooser page
  const only = memberships.length === 1 ? memberships[0]?.organizations : null;
  if (only) redirect(`/inbox?org=${only.id}`);

  return (
    <div className="shell">
      <header>
        <span className="brand">Zendori</span>
        <form action={signOut}>
          <button className="ghost" type="submit">
            Abmelden
          </button>
        </form>
      </header>

      <div className="page-head">
        <h1>Organisation wählen</h1>
        <p>Du bist Mitglied in mehreren Organisationen — wähle, wo du arbeiten möchtest.</p>
      </div>

      <div className="panel">
        <h2>Deine Organisationen</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Deine Rolle</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {memberships.map((m) =>
              m.organizations ? (
                <tr key={m.organizations.id}>
                  <td>{m.organizations.name}</td>
                  <td>{m.organizations.slug}</td>
                  <td>
                    <span className="badge">{m.role === 'owner' ? 'Inhaber' : m.role === 'admin' ? 'Admin' : 'Mitarbeiter'}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Link className="primary" href={`/inbox?org=${m.organizations.id}`}>
                      Inbox öffnen
                    </Link>
                  </td>
                </tr>
              ) : null
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}
