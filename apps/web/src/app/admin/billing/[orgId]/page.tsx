// Per-customer billing drill-down (platform admin): the combined invoice (usage
// priced through the org's tier + package fees + setup), package assignment, and
// the most recent measured transactions. Service-role reads behind requirePlatformAdmin.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/admin-auth';
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
import { assignPackage, removeSubscription } from '../actions';

const STEP_LABELS: Record<string, string> = {
  classify: 'Klassifikation',
  extract: 'Extraktion',
  retrieve: 'Wissenssuche',
  rerank: 'Re-Ranking',
  draft: 'Antwort-Entwurf',
  learn: 'Lernen',
  transcribe: 'Transkription',
};

const USAGE_LABELS: Record<string, string> = {
  voice_minutes: 'Telefonminuten',
  index_embeddings: 'KB-Indexierung',
  whatsapp_message: 'WhatsApp',
  email: 'E-Mail',
  sip_minutes: 'SIP-Minuten',
  other: 'Sonstiges',
};

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

type TxRow = { when: string; label: string; source: string; costUsd: number };

export default async function AdminOrgBillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ month?: string; error?: string; notice?: string }>;
}) {
  await requirePlatformAdmin();
  const { orgId } = await params;
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

  const { data: orgRow } = await admin
    .from('organizations')
    .select('id, name')
    .eq('id', orgId)
    .maybeSingle();
  if (!orgRow) notFound();
  const org = orgRow as { id: string; name: string };

  const months = recentMonths(new Date(), 12);
  const period = parseMonthKey(month, currentMonth(new Date()));
  const catalog = await loadBillingCatalog(admin);
  const invoice = await getOrgInvoice(admin, orgId, period, catalog);
  const sub = catalog.subscriptions.get(orgId);
  const tiers = [...catalog.tiers.values()].sort((a, b) => a.name.localeCompare(b.name));
  const packages = [...catalog.packages.values()]
    .filter((p) => p.isActive)
    .sort((a, b) => a.name.localeCompare(b.name));

  const costEur = (usd: number) => Math.round(usd * catalog.ctx.usdToEur * 100) / 100;

  const [{ data: aiRunsData }, { data: usageData }] = await Promise.all([
    admin
      .from('ai_runs')
      .select('step, cost_usd, created_at')
      .eq('org_id', orgId)
      .gte('created_at', period.fromIso)
      .lt('created_at', period.toIso)
      .order('created_at', { ascending: false })
      .limit(30),
    admin
      .from('usage_events')
      .select('category, cost_usd, occurred_at')
      .eq('org_id', orgId)
      .gte('occurred_at', period.fromIso)
      .lt('occurred_at', period.toIso)
      .order('occurred_at', { ascending: false })
      .limit(30),
  ]);

  const txns: TxRow[] = [
    ...((aiRunsData ?? []) as { step: string; cost_usd: number | null; created_at: string }[]).map(
      (r) => ({ when: r.created_at, label: STEP_LABELS[r.step] ?? r.step, source: 'KI', costUsd: Number(r.cost_usd) || 0 })
    ),
    ...((usageData ?? []) as { category: string; cost_usd: number | null; occurred_at: string }[]).map(
      (r) => ({ when: r.occurred_at, label: USAGE_LABELS[r.category] ?? r.category, source: 'Infrastruktur', costUsd: Number(r.cost_usd) || 0 })
    ),
  ]
    .sort((a, b) => Date.parse(b.when) - Date.parse(a.when))
    .slice(0, 30);

  return (
    <div className="shell">
      <div className="page-head">
        <h1>{org.name} — Abrechnung</h1>
        <p>
          <Link href={`/admin/billing?month=${period.key}`}>← Zurück zur Übersicht</Link>
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
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
          </div>
          <button className="ghost" type="submit">Anzeigen</button>
        </form>
      </div>

      <div className="panel">
        <h2>Rechnung — {period.label}</h2>
        {invoice.packageName ? (
          <p className="help">
            Paket: <strong>{invoice.packageName}</strong> ·{' '}
            {invoice.interval === 'yearly' ? 'jährliche' : 'monatliche'} Laufzeit
          </p>
        ) : (
          <p className="help">Kein Paket zugewiesen — nur Verbrauch wird berechnet.</p>
        )}
        <table>
          <thead>
            <tr>
              <th>Position</th>
              <th style={{ textAlign: 'right' }}>Menge</th>
              <th style={{ textAlign: 'right' }}>Kosten</th>
              <th style={{ textAlign: 'right' }}>Preis</th>
            </tr>
          </thead>
          <tbody>
            {invoice.recurring.map((line, i) => (
              <tr key={`rec-${i}`}>
                <td>{line.label}</td>
                <td></td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>—</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatEur(line.amountEur)}</td>
              </tr>
            ))}
            {invoice.usage.lines.map((line) => (
              <tr key={line.category}>
                <td>{line.label}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                  {formatQuantity(line.quantity, line.unit)}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{formatEur(costEur(line.costUsd))}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatEur(line.priceEur)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>Summe</th>
              <th></th>
              <th style={{ textAlign: 'right' }}>{formatEur(costEur(invoice.usage.totalCostUsd))}</th>
              <th style={{ textAlign: 'right' }}>{formatEur(invoice.grandTotalEur)}</th>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="panel">
        <h2>Paket zuweisen</h2>
        <p className="help">
          Weist dem Kunden ein Paket zu (setzt dessen Kanal-Kontingente). Die Preisliste bestimmt
          die Verbrauchspreise; optional eine andere Liste für bessere Konditionen wählen.
        </p>
        <form className="stack" action={assignPackage} style={{ maxWidth: '26rem' }}>
          <input type="hidden" name="orgId" value={orgId} />
          <div>
            <label htmlFor="packageId">Paket</label>
            <select id="packageId" name="packageId" defaultValue={sub?.packageId ?? ''}>
              <option value="">— kein Paket —</option>
              {packages.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="priceTierId">Preisliste (optional, bessere Konditionen)</label>
            <select id="priceTierId" name="priceTierId" defaultValue={sub?.priceTierId ?? ''}>
              <option value="">— aus Paket übernehmen —</option>
              {tiers.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="interval">Laufzeit</label>
            <select id="interval" name="interval" defaultValue={sub?.interval ?? 'monthly'}>
              <option value="monthly">Monatlich</option>
              <option value="yearly">Jährlich</option>
            </select>
          </div>
          <div>
            <label htmlFor="setupFeeEur">Setup-Gebühr-Override (€, optional)</label>
            <input
              id="setupFeeEur"
              name="setupFeeEur"
              type="text"
              inputMode="decimal"
              placeholder="aus Paket"
              defaultValue={sub?.setupFeeEur != null ? String(sub.setupFeeEur) : ''}
            />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="primary" type="submit">Zuweisen / Speichern</button>
          </div>
        </form>
        {sub ? (
          <form action={removeSubscription} style={{ marginTop: '0.75rem' }}>
            <input type="hidden" name="orgId" value={orgId} />
            <button className="ghost" type="submit">Zuweisung entfernen</button>
          </form>
        ) : null}
      </div>

      <div className="panel">
        <h2>Letzte Vorgänge</h2>
        {txns.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            In {period.label} wurden noch keine kostenpflichtigen Vorgänge erfasst.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Zeitpunkt</th>
                <th>Vorgang</th>
                <th>Quelle</th>
                <th style={{ textAlign: 'right' }}>Kosten</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((t, i) => (
                <tr key={`${t.when}-${i}`}>
                  <td style={{ color: 'var(--text-muted)' }}>{formatDateTime(t.when)}</td>
                  <td>{t.label}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{t.source}</td>
                  <td style={{ textAlign: 'right' }}>{formatEur(costEur(t.costUsd))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="help" style={{ marginTop: '0.75rem' }}>
          WhatsApp-, E-Mail- und Rufnummern-Kosten werden aus Mengen × Preistabelle berechnet und
          erscheinen nur in der Rechnung, nicht als Einzelvorgang.
        </p>
      </div>
    </div>
  );
}
