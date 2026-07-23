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

type OrgRow = { id: string; name: string };

export default async function AdminBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; error?: string; notice?: string }>;
}) {
  await requirePlatformAdmin();
  const { month, error, notice } = await searchParams;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return (
      <div className="shell">
        <div className="page-head">
          <h1>Abrechnung</h1>
        </div>
        <p className="error">Service-Role ist serverseitig nicht konfiguriert.</p>
      </div>
    );
  }

  const months = recentMonths(new Date(), 12);
  const period = parseMonthKey(month, currentMonth(new Date()));

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
    <div className="shell">
      <div className="page-head">
        <h1>Abrechnung</h1>
        <p>
          Monatssumme aller Kunden (Verbrauch + Paketgebühren). „Kosten" = unser Einkauf, „Preis" =
          Kundenbetrag. Preislisten und Pakete verwaltest du unter{' '}
          <Link href="/admin/pricing">Preise & Pakete</Link>.
        </p>
      </div>

      {error ? <p className="error" style={{ marginBottom: '1rem' }}>{error}</p> : null}
      {notice ? <p className="notice" style={{ marginBottom: '1rem' }}>{notice}</p> : null}

      <div className="panel">
        <form method="get" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
          <div>
            <label htmlFor="month">Abrechnungsmonat</label>
            <select id="month" name="month" defaultValue={period.key}>
              {months.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <button className="ghost" type="submit">Anzeigen</button>
        </form>
      </div>

      <div className="panel">
        <h2>{period.label}</h2>
        {rows.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Noch keine Organisationen vorhanden.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kunde</th>
                <th>Paket</th>
                <th style={{ textAlign: 'right' }}>Kosten</th>
                <th style={{ textAlign: 'right' }}>Preis</th>
                <th style={{ textAlign: 'right' }}>Marge</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.org.id}>
                  <td>
                    <Link href={`/admin/billing/${r.org.id}?month=${period.key}`} style={{ fontWeight: 600 }}>
                      {r.org.name}
                    </Link>
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{r.packageName ?? '—'}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{formatEur(r.costEur)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatEur(r.priceEur)}</td>
                  <td style={{ textAlign: 'right' }}>{formatEur(r.marginEur)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Summe</th>
                <th></th>
                <th style={{ textAlign: 'right' }}>{formatEur(totalCost)}</th>
                <th style={{ textAlign: 'right' }}>{formatEur(totalPrice)}</th>
                <th style={{ textAlign: 'right' }}>{formatEur(totalMargin)}</th>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

    </div>
  );
}
