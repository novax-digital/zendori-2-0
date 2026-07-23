// Customer billing area (self-service). Shows the org's own consumption per
// month with the € amount — never our raw USD cost or the markup (those stay in
// the service-role rollup). Owner-only: billing is money. requireActiveOrg has
// already verified membership, so the service-role read scoped to that orgId is
// safe and lets us compute € without exposing usage_events/billing_settings via
// the anon API.
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  currentMonth,
  formatEur,
  formatQuantity,
  getOrgBilling,
  loadPricing,
  parseMonthKey,
  recentMonths,
} from '@/lib/billing';

export default async function CustomerBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; month?: string }>;
}) {
  const { org, month } = await searchParams;
  const { orgId, role } = await requireActiveOrg(org);

  if (role !== 'owner') {
    return (
      <div className="shell">
        <div className="page-head">
          <h1>Abrechnung</h1>
        </div>
        <div className="panel">
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Die Abrechnung ist nur für Inhaber der Organisation sichtbar.
          </p>
        </div>
      </div>
    );
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return (
      <div className="shell">
        <div className="page-head">
          <h1>Abrechnung</h1>
        </div>
        <p className="error">Die Abrechnung ist derzeit nicht verfügbar.</p>
      </div>
    );
  }

  const months = recentMonths(new Date(), 12);
  const period = parseMonthKey(month, currentMonth(new Date()));
  const pricing = await loadPricing(admin);
  const breakdown = await getOrgBilling(
    admin,
    orgId,
    period.fromIso,
    period.toIso,
    pricing.forOrg(orgId)
  );

  const usedLines = breakdown.lines.filter((line) => line.quantity > 0 || line.priceEur > 0);

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Abrechnung</h1>
        <p>
          Dein Verbrauch pro Monat — KI-Antworten, Wissensdatenbank, Telefonie, WhatsApp und E-Mail.
          Die Beträge sind Netto in Euro.
        </p>
      </div>

      <div className="panel">
        <form method="get" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
          <input type="hidden" name="org" value={orgId} />
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
        {usedLines.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            In diesem Monat ist noch kein Verbrauch angefallen.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Leistung</th>
                <th style={{ textAlign: 'right' }}>Verbrauch</th>
                <th style={{ textAlign: 'right' }}>Betrag</th>
              </tr>
            </thead>
            <tbody>
              {usedLines.map((line) => (
                <tr key={line.category}>
                  <td>{line.label}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                    {formatQuantity(line.quantity, line.unit)}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatEur(line.priceEur)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Gesamt</th>
                <th></th>
                <th style={{ textAlign: 'right' }}>{formatEur(breakdown.totalPriceEur)}</th>
              </tr>
            </tfoot>
          </table>
        )}
        <p className="help" style={{ marginTop: '0.75rem' }}>
          Angaben ohne Gewähr — die endgültige Rechnung kann abweichen. Bei Fragen zur Abrechnung
          wende dich an deinen Ansprechpartner.
        </p>
      </div>
    </div>
  );
}
