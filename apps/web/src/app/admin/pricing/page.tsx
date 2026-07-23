// One consolidated pricing page (owner decision 2026-07-23: no FX, no factors —
// free EUR prices only). Three sections: purchase costs (Einkauf, incl. the two
// editable number rentals), price lists (free sell price per position; empty =
// pass-through at cost), and packages (setup + base fee + per-channel fee/quota).
// Platform-admin only; all reads/writes via the service role.
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { formatEur, loadBillingCatalog } from '@/lib/billing';
import {
  BILLING_CATEGORY_BILLING_LABEL,
  BILLING_CATEGORY_LABELS,
  BILLING_CATEGORY_ORDER,
  BILLING_CATEGORY_PRICE_UNIT,
  PACKAGE_CHANNEL_KINDS,
  PACKAGE_CHANNEL_LABELS,
  UNIT_PRICED_CATEGORIES,
  packageMonthlyTotalEur,
  packageYearlyTotalEur,
  unitCostEur,
  type BillingCategory,
  type PricingContext,
  type SupabaseClient,
  type UnitPricedCategory,
} from '@zendori/core';
import {
  createPackage,
  createPriceList,
  deletePackage,
  deletePriceList,
  updatePackage,
  updatePriceList,
  updatePurchaseCosts,
} from './actions';

function fmtUnit(value: number): string {
  return `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)} €`;
}

const isUnitPriced = (category: BillingCategory): category is UnitPricedCategory =>
  (UNIT_PRICED_CATEGORIES as readonly string[]).includes(category);

/** Which ai_runs steps roll up into which token category (mirrors billing_org_rollup). */
const STEP_CATEGORY: Record<string, 'ai' | 'embeddings' | 'transcription'> = {
  classify: 'ai',
  extract: 'ai',
  draft: 'ai',
  rerank: 'ai',
  learn: 'ai',
  retrieve: 'embeddings',
  transcribe: 'transcription',
};

/**
 * Ø purchase cost per Vorgang for the token categories, from recent samples.
 * Mirrors billing_org_rollup's Vorgang definition: ai_runs rows for the mapped
 * steps PLUS index_embeddings usage_events (each event = one Vorgang covering a
 * whole source index — these dominate the embeddings average and must not be
 * omitted, or the unter-Einkauf check would approve loss-making prices).
 * Display-only; a category without data is reported as absent.
 */
async function loadAvgTokenCosts(
  admin: SupabaseClient,
  usdToEur: number
): Promise<Partial<Record<'ai' | 'embeddings' | 'transcription', number>>> {
  const [{ data: runsData }, { data: idxData }] = await Promise.all([
    admin
      .from('ai_runs')
      .select('step, cost_usd')
      .order('created_at', { ascending: false })
      .limit(1000),
    admin
      .from('usage_events')
      .select('cost_usd')
      .eq('category', 'index_embeddings')
      .order('occurred_at', { ascending: false })
      .limit(500),
  ]);
  const sums: Record<string, { total: number; count: number }> = {};
  for (const row of (runsData ?? []) as { step: string; cost_usd: number | null }[]) {
    const category = STEP_CATEGORY[row.step];
    if (!category) continue;
    const bucket = (sums[category] ??= { total: 0, count: 0 });
    bucket.total += Number(row.cost_usd) || 0;
    bucket.count += 1;
  }
  for (const row of (idxData ?? []) as { cost_usd: number | null }[]) {
    const bucket = (sums.embeddings ??= { total: 0, count: 0 });
    bucket.total += Number(row.cost_usd) || 0;
    bucket.count += 1;
  }
  const out: Partial<Record<'ai' | 'embeddings' | 'transcription', number>> = {};
  for (const key of ['ai', 'embeddings', 'transcription'] as const) {
    const bucket = sums[key];
    if (bucket && bucket.count > 0) out[key] = (bucket.total / bucket.count) * usdToEur;
  }
  return out;
}

function einkaufLabel(
  category: BillingCategory,
  ctx: PricingContext,
  avg: Partial<Record<'ai' | 'embeddings' | 'transcription', number>>
): string {
  if (isUnitPriced(category)) return fmtUnit(unitCostEur(category, ctx));
  const value = avg[category as 'ai' | 'embeddings' | 'transcription'];
  return value !== undefined ? `Ø ${fmtUnit(value)}` : 'noch keine Daten';
}

function einkaufValue(
  category: BillingCategory,
  ctx: PricingContext,
  avg: Partial<Record<'ai' | 'embeddings' | 'transcription', number>>
): number | null {
  if (isUnitPriced(category)) return unitCostEur(category, ctx);
  return avg[category as 'ai' | 'embeddings' | 'transcription'] ?? null;
}

export default async function AdminPricingPage({
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
          <h1>Preise & Pakete</h1>
        </div>
        <p className="error">Service-Role ist serverseitig nicht konfiguriert.</p>
      </div>
    );
  }

  const catalog = await loadBillingCatalog(admin);
  const ctx = catalog.ctx;
  const avgTokenCosts = await loadAvgTokenCosts(admin, ctx.usdToEur);
  const priceLists = [...catalog.tiers.values()].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const packages = [...catalog.packages.values()].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Preise & Pakete</h1>
        <p>
          Alles an einem Ort: Einkaufspreise, Preislisten (freie €-Preise je Position) und Pakete.
          Kunden bekommen ihr Paket bzw. ihre Preisliste unter Abrechnung → Kunde zugewiesen.
        </p>
      </div>

      {error ? <p className="error" style={{ marginBottom: '1rem' }}>{error}</p> : null}
      {notice ? <p className="notice" style={{ marginBottom: '1rem' }}>{notice}</p> : null}

      <div className="panel">
        <h2>Einkaufspreise</h2>
        <p className="help">
          Was uns die Anbieter kosten. Die Rufnummern-Mieten trägst du selbst ein; bei den
          KI-Positionen ist es der Durchschnitt aus dem echten Verbrauch.
        </p>
        <form id="purchase-costs" action={updatePurchaseCosts} />
        <table>
          <thead>
            <tr>
              <th>Position</th>
              <th>Abrechnung</th>
              <th style={{ textAlign: 'right' }}>Einkauf</th>
            </tr>
          </thead>
          <tbody>
            {BILLING_CATEGORY_ORDER.map((category) => (
              <tr key={category}>
                <td>{BILLING_CATEGORY_LABELS[category]}</td>
                <td style={{ color: 'var(--text-muted)' }}>
                  {BILLING_CATEGORY_BILLING_LABEL[category]}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {category === 'numbers_mobile' || category === 'numbers_landline' ? (
                    <input
                      form="purchase-costs"
                      name={category === 'numbers_mobile' ? 'numberCostMobileEur' : 'numberCostLandlineEur'}
                      type="text"
                      inputMode="decimal"
                      required
                      defaultValue={String(
                        category === 'numbers_mobile' ? ctx.numberCostMobileEur : ctx.numberCostLandlineEur
                      )}
                      style={{ maxWidth: '6.5rem', textAlign: 'right' }}
                    />
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>
                      {einkaufLabel(category, ctx, avgTokenCosts)}
                    </span>
                  )}
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                    {' '}{BILLING_CATEGORY_PRICE_UNIT[category].replace('€', '')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="primary" type="submit" form="purchase-costs" style={{ marginTop: '0.75rem' }}>
          Einkaufspreise speichern
        </button>
      </div>

      <h2 style={{ margin: '1.5rem 0 0.75rem' }}>Preislisten</h2>
      {priceLists.map((list) => (
        <div className="panel" key={list.id}>
          <form className="stack" action={updatePriceList} id={`list-${list.id}`}>
            <input type="hidden" name="id" value={list.id} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                name="name"
                type="text"
                required
                minLength={2}
                maxLength={80}
                defaultValue={list.name}
                style={{ maxWidth: '18rem', fontWeight: 600 }}
              />
              {list.isDefault ? <span className="badge badge--success">Standard</span> : null}
            </div>
            <table>
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Abrechnung</th>
                  <th style={{ textAlign: 'right' }}>Einkauf</th>
                  <th style={{ textAlign: 'right' }}>Verkaufspreis</th>
                </tr>
              </thead>
              <tbody>
                {BILLING_CATEGORY_ORDER.map((category) => {
                  const rule = list.pricing[category];
                  const stored = rule?.mode === 'unit' ? rule.unitPriceEur : undefined;
                  const einkauf = einkaufValue(category, ctx, avgTokenCosts);
                  const belowCost = stored !== undefined && einkauf !== null && stored < einkauf;
                  return (
                    <tr key={category}>
                      <td>{BILLING_CATEGORY_LABELS[category]}</td>
                      <td style={{ color: 'var(--text-muted)' }}>
                        {BILLING_CATEGORY_BILLING_LABEL[category]}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                        {einkaufLabel(category, ctx, avgTokenCosts)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <input
                          name={`price_${category}`}
                          type="text"
                          inputMode="decimal"
                          placeholder="Selbstkosten"
                          defaultValue={stored ?? ''}
                          style={{
                            maxWidth: '7rem',
                            textAlign: 'right',
                            borderColor: belowCost ? 'var(--danger)' : undefined,
                          }}
                        />
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                          {' '}{BILLING_CATEGORY_PRICE_UNIT[category].replace('€', '')}
                        </span>
                        {belowCost ? (
                          <div style={{ color: 'var(--danger)', fontSize: '0.75rem' }}>unter Einkauf</div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </form>
          <p className="help" style={{ marginTop: '0.5rem' }}>
            Leeres Feld = Weitergabe zum Selbstkostenpreis (Einkauf).
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button className="primary" type="submit" form={`list-${list.id}`}>Speichern</button>
            {list.isDefault ? null : (
              <form action={deletePriceList}>
                <input type="hidden" name="id" value={list.id} />
                <button className="ghost" type="submit">Löschen</button>
              </form>
            )}
          </div>
        </div>
      ))}
      <div className="panel">
        <h2>Neue Preisliste</h2>
        <form className="stack" action={createPriceList} style={{ maxWidth: '22rem' }}>
          <div>
            <label htmlFor="new-list-name">Name</label>
            <input id="new-list-name" name="name" type="text" required minLength={2} maxLength={80} placeholder="z. B. Partner" />
          </div>
          <button className="primary" type="submit">Anlegen</button>
        </form>
      </div>

      <h2 style={{ margin: '1.5rem 0 0.75rem' }}>Pakete</h2>
      {packages.map((pkg) => (
        <div className="panel" key={pkg.id}>
          <form className="stack" action={updatePackage} id={`pkg-${pkg.id}`}>
            <input type="hidden" name="id" value={pkg.id} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-end' }}>
              <div>
                <label>Name</label>
                <input name="name" type="text" required minLength={2} maxLength={80} defaultValue={pkg.name} />
              </div>
              <div>
                <label>Preisliste</label>
                <select name="priceTierId" defaultValue={pkg.priceTierId ?? ''}>
                  <option value="">Standard</option>
                  {priceLists.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <input type="checkbox" name="isActive" defaultChecked={pkg.isActive} /> Aktiv
              </label>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <label>Setup-Gebühr (€, einmalig)</label>
                <input name="setupFeeEur" type="text" inputMode="decimal" defaultValue={String(pkg.setupFeeEur)} style={{ maxWidth: '9rem' }} />
              </div>
              <div>
                <label>Grundgebühr Monat (€)</label>
                <input name="baseFeeMonthlyEur" type="text" inputMode="decimal" defaultValue={String(pkg.baseFeeMonthlyEur)} style={{ maxWidth: '9rem' }} />
              </div>
              <div>
                <label>Grundgebühr Jahr (€)</label>
                <input name="baseFeeYearlyEur" type="text" inputMode="decimal" defaultValue={String(pkg.baseFeeYearlyEur)} style={{ maxWidth: '9rem' }} />
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Kanal-Typ</th>
                  <th style={{ textAlign: 'right' }}>Kontingent</th>
                  <th style={{ textAlign: 'right' }}>Fee/Monat (€)</th>
                  <th style={{ textAlign: 'right' }}>Fee/Jahr (€)</th>
                </tr>
              </thead>
              <tbody>
                {PACKAGE_CHANNEL_KINDS.map((kind) => {
                  const term = pkg.channels[kind];
                  return (
                    <tr key={kind}>
                      <td>{PACKAGE_CHANNEL_LABELS[kind]}</td>
                      <td style={{ textAlign: 'right' }}>
                        <input name={`quota_${kind}`} type="text" inputMode="numeric" placeholder="0" defaultValue={term ? String(term.quota) : ''} style={{ maxWidth: '5rem', textAlign: 'right' }} />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <input name={`feem_${kind}`} type="text" inputMode="decimal" placeholder="0" defaultValue={term ? String(term.feeMonthlyEur) : ''} style={{ maxWidth: '6rem', textAlign: 'right' }} />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <input name={`feey_${kind}`} type="text" inputMode="decimal" placeholder="0" defaultValue={term ? String(term.feeYearlyEur) : ''} style={{ maxWidth: '6rem', textAlign: 'right' }} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </form>
          <p className="help" style={{ marginTop: '0.5rem' }}>
            Aktuell gespeichert: <strong>{formatEur(packageMonthlyTotalEur(pkg))}/Monat</strong> ·{' '}
            <strong>{formatEur(packageYearlyTotalEur(pkg))}/Jahr</strong> + Setup {formatEur(pkg.setupFeeEur)}.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button className="primary" type="submit" form={`pkg-${pkg.id}`}>Speichern</button>
            <form action={deletePackage}>
              <input type="hidden" name="id" value={pkg.id} />
              <button className="ghost" type="submit">Löschen</button>
            </form>
          </div>
        </div>
      ))}
      <div className="panel">
        <h2>Neues Paket</h2>
        <form className="stack" action={createPackage} style={{ maxWidth: '22rem' }}>
          <div>
            <label htmlFor="new-pkg-name">Name</label>
            <input id="new-pkg-name" name="name" type="text" required minLength={2} maxLength={80} placeholder="z. B. Starter" />
          </div>
          <button className="primary" type="submit">Anlegen</button>
        </form>
      </div>
    </div>
  );
}
