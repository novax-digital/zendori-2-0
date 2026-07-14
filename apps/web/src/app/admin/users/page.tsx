import Link from 'next/link';
import type { CSSProperties } from 'react';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createCustomer } from './actions';

type OrgRow = { id: string; name: string; slug: string; created_at: string };
type MemberRow = { org_id: string; user_id: string; role: string };

const helpStyle: CSSProperties = {
  fontSize: '0.9rem',
  color: 'var(--text-muted)',
  marginBottom: '1.25rem',
};

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  await requirePlatformAdmin();
  const { error, notice } = await searchParams;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return (
      <div className="shell">
        <div className="page-head">
          <h1>Nutzer</h1>
        </div>
        <p className="error">Service-Role ist serverseitig nicht konfiguriert.</p>
      </div>
    );
  }

  const { data: orgData } = await admin
    .from('organizations')
    .select('id, name, slug, created_at')
    .order('created_at', { ascending: false });
  const orgs = (orgData ?? []) as OrgRow[];

  const { data: memberData } = await admin
    .from('org_members')
    .select('org_id, user_id, role');
  const members = (memberData ?? []) as MemberRow[];

  // owners + member counts per org
  const ownersByOrg = new Map<string, string[]>(); // org_id -> owner user_ids
  const countByOrg = new Map<string, number>();
  for (const m of members) {
    countByOrg.set(m.org_id, (countByOrg.get(m.org_id) ?? 0) + 1);
    if (m.role === 'owner') {
      const list = ownersByOrg.get(m.org_id) ?? [];
      list.push(m.user_id);
      ownersByOrg.set(m.org_id, list);
    }
  }

  // resolve owner e-mails server-side (never exposes the service key to the client)
  const ownerIds = [...new Set([...ownersByOrg.values()].flat())];
  const emailByUserId = new Map<string, string>();
  await Promise.all(
    ownerIds.map(async (id) => {
      const { data } = await admin.auth.admin.getUserById(id);
      if (data.user?.email) emailByUserId.set(id, data.user.email);
    })
  );

  const ownerLabel = (orgId: string): string => {
    const ids = ownersByOrg.get(orgId) ?? [];
    if (ids.length === 0) return '— kein Owner —';
    return ids.map((id) => emailByUserId.get(id) ?? `${id.slice(0, 8)}…`).join(', ');
  };

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Nutzer</h1>
        <p>
          Alle Kunden-Organisationen und ihre Owner. Klicke eine Organisation an, um ihr Team zu
          sehen und Zugänge anzulegen.
        </p>
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
        <h2>Organisationen</h2>
        {orgs.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Noch keine Organisationen vorhanden. Lege unten den ersten Kunden an.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Organisation</th>
                <th>Owner</th>
                <th>Mitglieder</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((org) => (
                <tr key={org.id}>
                  <td>
                    <Link href={`/admin/users/${org.id}`} style={{ fontWeight: 600 }}>
                      {org.name}
                    </Link>
                  </td>
                  <td style={{ color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                    {ownerLabel(org.id)}
                  </td>
                  <td>
                    <span className="badge">{countByOrg.get(org.id) ?? 0}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Neuen Kunden anlegen</h2>
        <p style={helpStyle}>
          Erstellt eine neue Organisation samt Owner-Konto. Das Konto ist sofort aktiv (keine
          E-Mail-Bestätigung nötig) — teile die Zugangsdaten dem Kunden sicher mit.
        </p>
        <form className="stack" action={createCustomer} style={{ maxWidth: '28rem' }}>
          <div>
            <label htmlFor="orgName">Firmenname</label>
            <input
              id="orgName"
              name="orgName"
              type="text"
              required
              minLength={2}
              maxLength={120}
              placeholder="z. B. Strong Energy GmbH"
            />
          </div>
          <div>
            <label htmlFor="cust-email">Owner-E-Mail</label>
            <input
              id="cust-email"
              name="email"
              type="email"
              required
              autoComplete="off"
              placeholder="inhaber@kunde.de"
            />
          </div>
          <div>
            <label htmlFor="cust-password">Initial-Passwort</label>
            <input
              id="cust-password"
              name="password"
              type="text"
              required
              minLength={8}
              maxLength={200}
              autoComplete="off"
              placeholder="min. 8 Zeichen"
            />
          </div>
          <button className="primary" type="submit">
            Kunde anlegen
          </button>
        </form>
      </div>
    </div>
  );
}
