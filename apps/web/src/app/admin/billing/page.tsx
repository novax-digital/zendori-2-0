// Platform-admin billing overview: every customer's usage cost for a month, with
// our internal cost, the customer € price, and the resulting margin. Cross-org
// reads go through the service role (requirePlatformAdmin gate). The global
// markup + FX defaults are edited here; per-org overrides live on the drill-down.
import Link from 'next/link';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  currentMonth,
  formatEur,
  getOrgBilling,
  loadPricing,
  parseMonthKey,
  recentMonths,
  type BillingBreakdown,
} from '@/lib/billing';
import { updateGlobalPricing } from './actions';

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

  const pricing = await loadPricing(admin);

  const rows = await Promise.all(
    orgs.map(async (org) => {
      const orgPricing = pricing.forOrg(org.id);
      const breakdown: BillingBreakdown = await getOrgBilling(
        admin,
        org.id,
        period.fromIso,
        period.toIso,
        orgPricing
      );
      const costEur = Math.round(breakdown.totalCostUsd * orgPricing.usdToEur * 100) / 100;
      return {
        org,
        priceEur: breakdown.totalPriceEur,
        costEur,
        marginEur: Math.round((breakdown.totalPriceEur - costEur) * 100) / 100,
        hasOverride: orgPricing !== pricing.global,
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
          Verbrauchskosten aller Kunden pro Monat. „Kosten" ist unser Einkauf (Anthropic, OpenAI,
          xAI, Twilio, Resend), „Preis" der Kundenbetrag nach Aufschlag. Klicke einen Kunden an für
          die Aufschlüsselung und einen individuellen Preis.
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
                    {r.hasOverride ? (
                      <span className="badge" style={{ marginLeft: '0.5rem' }}>eigener Preis</span>
                    ) : null}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{formatEur(r.costEur)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatEur(r.priceEur)}</td>
                  <td style={{ textAlign: 'right' }}>{formatEur(r.marginEur)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Summe</th>
                <th style={{ textAlign: 'right' }}>{formatEur(totalCost)}</th>
                <th style={{ textAlign: 'right' }}>{formatEur(totalPrice)}</th>
                <th style={{ textAlign: 'right' }}>{formatEur(totalMargin)}</th>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Globale Preis-Einstellungen</h2>
        <p className="help">
          Standard-Aufschlag und Wechselkurs für alle Kunden ohne individuellen Preis. Kundenpreis =
          Einkaufskosten (USD) × Wechselkurs × Aufschlag. Aufschlag 1,0 = ohne Marge (zum
          Selbstkostenpreis).
        </p>
        <form className="stack" action={updateGlobalPricing} style={{ maxWidth: '22rem' }}>
          <div>
            <label htmlFor="markupFactor">Aufschlag (Faktor)</label>
            <input
              id="markupFactor"
              name="markupFactor"
              type="text"
              inputMode="decimal"
              required
              defaultValue={String(pricing.global.markupFactor)}
            />
          </div>
          <div>
            <label htmlFor="usdToEur">Wechselkurs USD → EUR</label>
            <input
              id="usdToEur"
              name="usdToEur"
              type="text"
              inputMode="decimal"
              required
              defaultValue={String(pricing.global.usdToEur)}
            />
          </div>
          <button className="primary" type="submit">Speichern</button>
        </form>
      </div>
    </div>
  );
}
