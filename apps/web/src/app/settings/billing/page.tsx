// Customer billing area (self-service). Shows the org's own monthly invoice —
// package fees + consumption — with € amounts only; never our USD cost or the
// markup. Owner-only. requireActiveOrg verifies membership, so the service-role
// rollup scoped to that orgId is safe and keeps cost data server-side.
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  currentMonth,
  formatEur,
  formatQuantity,
  getOrgInvoice,
  loadBillingCatalog,
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
  const catalog = await loadBillingCatalog(admin);
  const invoice = await getOrgInvoice(admin, orgId, period, catalog);

  const usedLines = invoice.usage.lines.filter((line) => line.quantity > 0 || line.priceEur > 0);
  const hasRecurring = invoice.recurring.length > 0;
  const isEmpty = usedLines.length === 0 && !hasRecurring;

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Abrechnung</h1>
        <p>
          Deine Monatsrechnung — Paketgebühren und Verbrauch. Alle Beträge sind Netto in Euro.
          {invoice.packageName ? (
            <>
              {' '}Dein Paket: <strong>{invoice.packageName}</strong>
              {invoice.interval === 'yearly' ? ' (jährliche Laufzeit)' : ' (monatliche Laufzeit)'}.
            </>
          ) : null}
        </p>
      </div>

      <div className="panel">
        <form method="get" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
          <input type="hidden" name="org" value={orgId} />
          <div>
            <label htmlFor="month">Abrechnungsmonat</label>
            <select id="month" name="month" defaultValue={period.key}>
              {months.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
          </div>
          <button className="ghost" type="submit">Anzeigen</button>
        </form>
      </div>

      <div className="panel">
        <h2>{period.label}</h2>
        {isEmpty ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            In diesem Monat ist noch nichts angefallen.
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
              {invoice.recurring.map((line, i) => (
                <tr key={`rec-${i}`}>
                  <td>{line.label}</td>
                  <td></td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatEur(line.amountEur)}</td>
                </tr>
              ))}
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
                <th style={{ textAlign: 'right' }}>{formatEur(invoice.grandTotalEur)}</th>
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
