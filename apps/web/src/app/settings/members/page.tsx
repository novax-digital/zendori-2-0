import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createInvite, deleteInvite } from '../../actions';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { appUrl } from '@/lib/env';

type MemberRow = { org_id: string; user_id: string; role: string; created_at: string };
type InviteRow = { id: string; email: string; role: string; token: string; expires_at: string };

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
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
  const isOwner = membership.role === 'owner';

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

  let invites: InviteRow[] = [];
  if (isOwner) {
    const { data: inviteData } = await supabase
      .from('invites')
      .select('id, email, role, token, expires_at')
      .eq('org_id', orgId)
      .is('accepted_at', null)
      .order('created_at', { ascending: false });
    invites = (inviteData ?? []) as InviteRow[];
  }

  return (
    <div className="shell">
      <header>
        <span className="brand">Zendori</span>
        <Link href="/">Zurück zur Übersicht</Link>
      </header>

      <div className="panel">
        <h2>Mitglieder — {membership.organizations?.name ?? 'Organisation'}</h2>
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
      </div>

      {isOwner ? (
        <>
          <div className="panel">
            <h2>Mitglied einladen</h2>
            {error ? (
              <p className="error" style={{ marginBottom: '1rem' }}>
                {error}
              </p>
            ) : null}
            <form className="stack" action={createInvite} style={{ maxWidth: '26rem' }}>
              <input type="hidden" name="orgId" value={orgId} />
              <div>
                <label htmlFor="email">E-Mail-Adresse</label>
                <input id="email" name="email" type="email" required />
              </div>
              <div>
                <label htmlFor="role">Rolle</label>
                <select id="role" name="role" defaultValue="agent">
                  <option value="agent">Agent</option>
                  <option value="owner">Owner</option>
                </select>
              </div>
              <button className="primary" type="submit">
                Einladung erstellen
              </button>
            </form>
          </div>

          {invites.length > 0 ? (
            <div className="panel">
              <h2>Offene Einladungen</h2>
              {invites.map((invite) => (
                <div key={invite.id} style={{ marginBottom: '1.25rem' }}>
                  <strong>{invite.email}</strong>{' '}
                  <span className="badge">{invite.role === 'owner' ? 'Owner' : 'Agent'}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                    {' '}
                    — gültig bis {new Date(invite.expires_at).toLocaleDateString('de-DE')}
                  </span>
                  <code className="invite-link">
                    {appUrl()}/invite/{invite.token}
                  </code>
                  <form action={deleteInvite} style={{ marginTop: '0.4rem' }}>
                    <input type="hidden" name="id" value={invite.id} />
                    <button className="ghost" type="submit">
                      Einladung zurückziehen
                    </button>
                  </form>
                </div>
              ))}
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Sende den Link an die eingeladene Person. Sie registriert sich mit genau dieser
                E-Mail-Adresse und öffnet dann den Link.
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
