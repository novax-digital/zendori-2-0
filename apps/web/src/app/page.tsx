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
                    <span className="badge">{m.role === 'owner' ? 'Owner' : 'Agent'}</span>
                  </td>
                  <td>
                    <Link href={`/inbox?org=${m.organizations.id}`}>Inbox öffnen</Link>
                    {' · '}
                    <Link href={`/settings/members?org=${m.organizations.id}`}>
                      Mitglieder verwalten
                    </Link>
                  </td>
                </tr>
              ) : null
            )}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Nächste Schritte</h2>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Die Shared Inbox ist bereit: Lege unter „Einstellungen → Kanäle" einen Test-Channel an und
          speise über „Test-Channel" Nachrichten ein. Weitere Kanäle (Chat-Widget, E-Mail, WhatsApp)
          folgen in den nächsten Ausbauphasen.
        </p>
      </div>
    </div>
  );
}
