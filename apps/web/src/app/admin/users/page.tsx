import Link from 'next/link';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import DismissibleBanners from '@/components/DismissibleBanners';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import AdminUnavailable from '../_components/AdminUnavailable';
import { createCustomer } from './actions';

type OrgRow = { id: string; name: string; slug: string; created_at: string };
type MemberRow = { org_id: string; user_id: string; role: string };

const BASE = '/admin/users';

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; panel?: string }>;
}) {
  await requirePlatformAdmin();
  const { error, notice, panel } = await searchParams;

  const admin = createSupabaseAdminClient();
  if (!admin) return <AdminUnavailable title="Nutzer" />;

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
    if (ids.length === 0) return 'Kein Inhaber';
    return ids.map((id) => emailByUserId.get(id) ?? `${id.slice(0, 8)}…`).join(', ');
  };

  // The create form lives in a drawer (?panel=new); its errors show inside it.
  const creating = panel === 'new';

  return (
    <div className="page">
      <PageHeader
        title="Nutzer"
        subtitle="Alle Kunden-Organisationen und ihre Inhaber."
        actions={
          <Button href={`${BASE}?panel=new`} variant="primary" icon="plus" scroll={false}>
            Neuer Kunde
          </Button>
        }
      />

      <div className="page-body">
        <DismissibleBanners
          error={creating ? undefined : error}
          notice={notice}
        />

        {orgs.length === 0 ? (
          <EmptyState
            title="Noch keine Organisationen"
            text="Ein Kunde ist eine Organisation mit einem Inhaber-Konto."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>Inhaber</th>
                  <th className="right">Mitglieder</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((org) => (
                  <tr key={org.id}>
                    <td>
                      <Link href={`${BASE}/${org.id}`} className="cell-title">
                        {org.name}
                      </Link>
                    </td>
                    <td className="muted admin-break">{ownerLabel(org.id)}</td>
                    <td className="right">
                      <Badge>{countByOrg.get(org.id) ?? 0}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating ? (
        <Drawer
          title="Neuer Kunde"
          closeHref={BASE}
          footer={
            <>
              <Button href={BASE} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="new-customer" variant="primary">
                Kunde anlegen und einladen
              </Button>
            </>
          }
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <form id="new-customer" action={createCustomer} className="stack">
            <Field label="Firmenname" htmlFor="orgName">
              <input
                id="orgName"
                name="orgName"
                type="text"
                required
                minLength={2}
                maxLength={120}
                placeholder="z. B. Strong Energy GmbH"
              />
            </Field>
            <Field
              label="E-Mail des Inhabers"
              htmlFor="cust-email"
              help="Legt die Organisation samt Inhaber-Konto an. Der Inhaber erhält eine Einladung und legt sein Passwort selbst fest."
            >
              <input
                id="cust-email"
                name="email"
                type="email"
                required
                autoComplete="off"
                placeholder="inhaber@kunde.de"
              />
            </Field>
          </form>
        </Drawer>
      ) : null}
    </div>
  );
}
