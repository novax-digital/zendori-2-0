import { notFound } from 'next/navigation';
import { ORG_ROLE_LABELS, type Channel, type ChannelKind, type OrgRole } from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { CHANNEL_KIND_LABELS, countChannelsByKind } from '@/lib/channel-limits';
import { loadBillingCatalog } from '@/lib/billing';
import DismissibleBanners from '@/components/DismissibleBanners';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { Section } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import AdminUnavailable from '../../_components/AdminUnavailable';
import TermsSummary from '../../_components/TermsSummary';
import { addMember } from '../actions';

type MemberRow = { user_id: string; role: string; created_at: string };

const KIND_ORDER: ChannelKind[] = ['form', 'email', 'whatsapp', 'voice', 'chat', 'test'];

export default async function AdminOrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string; notice?: string; panel?: string }>;
}) {
  await requirePlatformAdmin();
  const { orgId } = await params;
  const { error, notice, panel } = await searchParams;

  const admin = createSupabaseAdminClient();
  if (!admin) return <AdminUnavailable title="Nutzer" />;

  const { data: orgRow } = await admin
    .from('organizations')
    .select('id, name, slug')
    .eq('id', orgId)
    .maybeSingle();
  if (!orgRow) notFound();
  const org = orgRow as { id: string; name: string; slug: string };

  const { data: memberData } = await admin
    .from('org_members')
    .select('user_id, role, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  const members = (memberData ?? []) as MemberRow[];

  // Effective quotas (0017, derived from the customer's terms) + live counts.
  const [{ data: limitData }, { data: channelData }, catalog] = await Promise.all([
    admin.from('org_channel_limits').select('channel_kind, max_count').eq('org_id', orgId),
    admin.from('channels').select('type, config').eq('org_id', orgId),
    loadBillingCatalog(admin),
  ]);
  const limits = new Map(
    ((limitData ?? []) as { channel_kind: ChannelKind; max_count: number }[]).map((r) => [
      r.channel_kind,
      r.max_count,
    ])
  );
  const counts = countChannelsByKind((channelData ?? []) as Pick<Channel, 'type' | 'config'>[]);

  const sub = catalog.subscriptions.get(orgId);
  const currentPackage = sub?.packageId ? catalog.packages.get(sub.packageId) : undefined;

  const emailByUserId = new Map<string, string>();
  await Promise.all(
    members.map(async (m) => {
      const { data } = await admin.auth.admin.getUserById(m.user_id);
      if (data.user?.email) emailByUserId.set(m.user_id, data.user.email);
    })
  );

  const base = `/admin/users/${org.id}`;
  // The invite form lives in a drawer (?panel=member); its errors show inside.
  const inviting = panel === 'member';

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: 'Nutzer', href: '/admin/users' }, { label: org.name }]}
        title={org.name}
        subtitle="Team, Konditionen und Kanal-Kontingente dieser Organisation."
        actions={
          <Button href={`${base}?panel=member`} variant="primary" icon="plus" scroll={false}>
            Mitglied einladen
          </Button>
        }
      />

      <div className="page-split">
        <div className="page-body">
          <DismissibleBanners error={inviting ? undefined : error} notice={notice} />

          <Section
            title="Mitglieder"
            help="Granulare Mitarbeiter-Rechte verwaltet der Kunde selbst in seinen Team-Einstellungen."
          >
            <div className="table-wrap">
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
                      <td className="admin-break">
                        {emailByUserId.get(m.user_id) ?? `${m.user_id.slice(0, 8)}…`}
                      </td>
                      <td>
                        <Badge>{ORG_ROLE_LABELS[m.role as OrgRole] ?? m.role}</Badge>
                      </td>
                      <td className="muted">
                        {new Date(m.created_at).toLocaleDateString('de-DE')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title="Wirksame Kanal-Kontingente"
            help={
              currentPackage
                ? `Aus dem Paket „${currentPackage.name}“ und den eigenen Werten dieses Kunden, hier nur zur Kontrolle.`
                : 'Kein Paket zugewiesen. Die Tabelle zeigt, was gerade gilt.'
            }
          >
            <div className="table-wrap form-narrow">
              <table className="table--compact">
                <thead>
                  <tr>
                    <th>Kanalart</th>
                    <th className="right">Vorhanden</th>
                    <th className="right">Kontingent</th>
                  </tr>
                </thead>
                <tbody>
                  {KIND_ORDER.map((kind) => (
                    <tr key={kind}>
                      <td>{CHANNEL_KIND_LABELS[kind]}</td>
                      <td className="right muted">{counts.get(kind) ?? 0}</td>
                      <td className="right">
                        {limits.has(kind) ? String(limits.get(kind)) : 'unbegrenzt'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>

        <aside className="page-rail" aria-label="Konditionen">
          <TermsSummary catalog={catalog} orgId={org.id} />
        </aside>
      </div>

      {inviting ? (
        <Drawer
          title="Mitglied einladen"
          closeHref={base}
          footer={
            <>
              <Button href={base} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="new-member" variant="primary">
                Mitglied einladen
              </Button>
            </>
          }
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <form id="new-member" action={addMember} className="stack">
            <input type="hidden" name="orgId" value={org.id} />
            <Field
              label="E-Mail"
              htmlFor="mem-email"
              help="Das Mitglied erhält eine Einladung und legt sein Passwort selbst fest."
            >
              <input
                id="mem-email"
                name="email"
                type="email"
                required
                autoComplete="off"
                placeholder="mitarbeiter@kunde.de"
              />
            </Field>
            <Field label="Rolle" htmlFor="mem-role">
              <select id="mem-role" name="role" defaultValue="agent">
                <option value="agent">Mitarbeiter</option>
                <option value="admin">Admin</option>
                <option value="owner">Inhaber</option>
              </select>
            </Field>
          </form>
        </Drawer>
      ) : null}
    </div>
  );
}
