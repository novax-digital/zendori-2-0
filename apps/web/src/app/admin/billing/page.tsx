// Platform-admin billing overview: every customer's monthly total (usage +
// package fees), our cost, and the margin. Cross-org reads go through the service
// role (requirePlatformAdmin gate). Prices/packages live under /admin/pricing,
// per-customer assignment on the drill-down.
import Link from 'next/link';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  currentMonth,
  formatEur,
  getOrgInvoice,
  loadBillingCatalog,
  parseMonthKey,
  recentMonths,
} from '@/lib/billing';
import { stripeRuntime } from '@/lib/stripe';
import DismissibleBanners from '@/components/DismissibleBanners';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { EmptyState, Section, Stat, Stats } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import AdminUnavailable from '../_components/AdminUnavailable';

type OrgRow = { id: string; name: string };

export default async function AdminBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; error?: string; notice?: string }>;
}) {
  await requirePlatformAdmin();
  const { month, error, notice } = await searchParams;

  const admin = createSupabaseAdminClient();
  if (!admin) return <AdminUnavailable title="Abrechnung" />;

  const months = recentMonths(new Date(), 12);
  const period = parseMonthKey(month, currentMonth(new Date()));
  // Phase 15: which Stripe mode this deployment runs in (null = not configured)
  const stripe = stripeRuntime();

  const { data: orgData } = await admin
    .from('organizations')
    .select('id, name')
    .order('name', { ascending: true });
  const orgs = (orgData ?? []) as OrgRow[];

  const catalog = await loadBillingCatalog(admin);

  const rows = await Promise.all(
    orgs.map(async (org) => {
      const invoice = await getOrgInvoice(admin, org.id, period, catalog);
      const costEur = Math.round(invoice.usage.totalCostUsd * catalog.ctx.usdToEur * 100) / 100;
      return {
        org,
        priceEur: invoice.grandTotalEur,
        costEur,
        marginEur: Math.round((invoice.grandTotalEur - costEur) * 100) / 100,
        packageName: invoice.packageName,
      };
    })
  );
  rows.sort((a, b) => b.priceEur - a.priceEur);

  const totalPrice = Math.round(rows.reduce((s, r) => s + r.priceEur, 0) * 100) / 100;
  const totalCost = Math.round(rows.reduce((s, r) => s + r.costEur, 0) * 100) / 100;
  const totalMargin = Math.round((totalPrice - totalCost) * 100) / 100;

  return (
    <div className="page">
      <PageHeader
        title="Abrechnung"
        subtitle="Monatssumme aller Kunden aus Verbrauch und Paketgebühren."
      />

      <div className="page-body">
        <DismissibleBanners error={error} notice={notice} />

        {stripe === null ? (
          <Callout>
            Stripe ist nicht eingerichtet (STRIPE_SECRET_KEY fehlt). Kunden werden nicht automatisch
            abgerechnet.
          </Callout>
        ) : stripe.livemode ? null : (
          <Callout tone="warn">
            Stripe läuft im Testmodus: Zahlungsarten werden nicht belastet. Die Abrechnung über
            Stripe schaltest du je Kunde auf dessen Seite ein.
          </Callout>
        )}

        <form method="get" className="toolbar">
          <select name="month" aria-label="Abrechnungsmonat" defaultValue={period.key}>
            {months.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
          <Button type="submit">Anzeigen</Button>
        </form>

        <Section
          title={period.label}
          help="„Preis“ ist der Kundenbetrag, „Kosten“ unser Einkauf."
        >
          <Stats>
            <Stat label="Preis" value={formatEur(totalPrice)} />
            <Stat label="Kosten" value={formatEur(totalCost)} />
            <Stat label="Marge" value={formatEur(totalMargin)} />
          </Stats>
        </Section>

        <Section title="Kunden">
          {rows.length === 0 ? (
            <EmptyState title="Noch keine Organisationen" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Kunde</th>
                    <th>Paket</th>
                    <th className="right">Kosten</th>
                    <th className="right">Preis</th>
                    <th className="right">Marge</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.org.id}>
                      <td>
                        <Link
                          href={`/admin/billing/${r.org.id}?month=${period.key}`}
                          className="cell-title"
                        >
                          {r.org.name}
                        </Link>
                      </td>
                      <td className="muted">{r.packageName ?? 'Kein Paket'}</td>
                      <td className="right muted">{formatEur(r.costEur)}</td>
                      <td className="right strong">{formatEur(r.priceEur)}</td>
                      <td className="right">{formatEur(r.marginEur)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="table-sum">
                    <th scope="row">Summe</th>
                    <td />
                    <td className="right">{formatEur(totalCost)}</td>
                    <td className="right">{formatEur(totalPrice)}</td>
                    <td className="right">{formatEur(totalMargin)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
