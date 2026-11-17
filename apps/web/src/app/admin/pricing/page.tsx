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
import DismissibleBanners from '@/components/DismissibleBanners';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { EmptyState, Section } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import AdminUnavailable from '../_components/AdminUnavailable';

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

const BASE = '/admin/pricing';

/** "€/Monat" → "/Monat": the unit shown behind a price field. */
const unitSuffix = (category: BillingCategory): string =>
  BILLING_CATEGORY_PRICE_UNIT[category].replace('€', '').trim();

export default async function AdminPricingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; panel?: string }>;
}) {
  await requirePlatformAdmin();
  const { error, notice, panel } = await searchParams;

  const admin = createSupabaseAdminClient();
  if (!admin) return <AdminUnavailable title="Preise & Pakete" />;

  const catalog = await loadBillingCatalog(admin);
  const ctx = catalog.ctx;
  const avgTokenCosts = await loadAvgTokenCosts(admin, ctx.usdToEur);
  const priceLists = [...catalog.tiers.values()].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const packages = [...catalog.packages.values()].sort((a, b) => a.name.localeCompare(b.name));

  // The two create forms live in drawers (?panel=list | package); their errors show inside.
  const newList = panel === 'list';
  const newPackage = panel === 'package';

  return (
    <div className="page">
      <PageHeader
        title="Preise & Pakete"
        subtitle="Einkaufspreise, Preislisten und Pakete an einem Ort."
      />

      <div className="page-body">
        <DismissibleBanners
          error={newList || newPackage ? undefined : error}
          notice={notice}
        />

        <Section
          title="Einkaufspreise"
          help="Was uns die Anbieter kosten. Die Rufnummern-Mieten trägst du selbst ein, bei den KI-Positionen ist es der Durchschnitt aus dem echten Verbrauch."
          actions={
            <Button type="submit" form="purchase-costs" size="sm">
              Einkaufspreise speichern
            </Button>
          }
        >
          <form id="purchase-costs" action={updatePurchaseCosts} />
          <div className="table-wrap">
            <table className="table--compact">
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Abrechnung</th>
                  <th className="right">Einkauf</th>
                </tr>
              </thead>
              <tbody>
                {BILLING_CATEGORY_ORDER.map((category) => (
                  <tr key={category}>
                    <td>{BILLING_CATEGORY_LABELS[category]}</td>
                    <td className="muted">{BILLING_CATEGORY_BILLING_LABEL[category]}</td>
                    <td className="right">
                      <span className="num-cell">
                        {category === 'numbers_mobile' || category === 'numbers_landline' ? (
                          <input
                            form="purchase-costs"
                            name={
                              category === 'numbers_mobile'
                                ? 'numberCostMobileEur'
                                : 'numberCostLandlineEur'
                            }
                            type="text"
                            inputMode="decimal"
                            required
                            aria-label={`Einkauf ${BILLING_CATEGORY_LABELS[category]}`}
                            className="num-input"
                            defaultValue={String(
                              category === 'numbers_mobile'
                                ? ctx.numberCostMobileEur
                                : ctx.numberCostLandlineEur
                            )}
                          />
                        ) : (
                          <span className="muted">{einkaufLabel(category, ctx, avgTokenCosts)}</span>
                        )}
                        <span className="muted small">{unitSuffix(category)}</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section
          title="Preislisten"
          help="Freie €-Preise je Position. Ein leeres Feld gibt den Einkaufspreis weiter."
          actions={
            <Button href={`${BASE}?panel=list`} size="sm" icon="plus" scroll={false}>
              Neue Preisliste
            </Button>
          }
        >
          {priceLists.map((list) => {
            const formId = `list-${list.id}`;
            return (
              <div className="pricing-item" key={list.id}>
                <div className="row row--between">
                  <div className="row grow">
                    <input
                      form={formId}
                      name="name"
                      type="text"
                      required
                      minLength={2}
                      maxLength={80}
                      defaultValue={list.name}
                      aria-label="Name der Preisliste"
                      className="pricing-item-name"
                    />
                    {list.isDefault ? <Badge tone="success">Standard</Badge> : null}
                  </div>
                  <div className="row">
                    <Button type="submit" form={formId} size="sm">
                      Speichern
                    </Button>
                    {list.isDefault ? null : (
                      <Menu label={`Aktionen für Preisliste ${list.name}`}>
                        <form action={deletePriceList}>
                          <input type="hidden" name="id" value={list.id} />
                          <button className="menu-item menu-item--danger" type="submit">
                            <span className="menu-label">Preisliste löschen</span>
                          </button>
                        </form>
                      </Menu>
                    )}
                  </div>
                </div>
                <form id={formId} action={updatePriceList}>
                  <input type="hidden" name="id" value={list.id} />
                  <div className="table-wrap">
                    <table className="table--compact">
                      <thead>
                        <tr>
                          <th>Position</th>
                          <th>Abrechnung</th>
                          <th className="right">Einkauf</th>
                          <th className="right">Verkaufspreis</th>
                        </tr>
                      </thead>
                      <tbody>
                        {BILLING_CATEGORY_ORDER.map((category) => {
                          const rule = list.pricing[category];
                          const stored = rule?.mode === 'unit' ? rule.unitPriceEur : undefined;
                          const einkauf = einkaufValue(category, ctx, avgTokenCosts);
                          const belowCost =
                            stored !== undefined && einkauf !== null && stored < einkauf;
                          return (
                            <tr key={category}>
                              <td>{BILLING_CATEGORY_LABELS[category]}</td>
                              <td className="muted">{BILLING_CATEGORY_BILLING_LABEL[category]}</td>
                              <td className="right muted">
                                {einkaufLabel(category, ctx, avgTokenCosts)}
                              </td>
                              <td className="right">
                                <span className="num-cell">
                                  <input
                                    name={`price_${category}`}
                                    type="text"
                                    inputMode="decimal"
                                    placeholder="Selbstkosten"
                                    defaultValue={stored ?? ''}
                                    aria-label={`Verkaufspreis ${BILLING_CATEGORY_LABELS[category]}`}
                                    // a price below our purchase cost is flagged, not blocked
                                    aria-invalid={belowCost || undefined}
                                    className="num-input"
                                  />
                                  <span className="muted small">{unitSuffix(category)}</span>
                                </span>
                                {belowCost ? <div className="field-error">unter Einkauf</div> : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </form>
              </div>
            );
          })}
        </Section>

        <Section
          title="Pakete"
          help="Setup-Gebühr, Grundgebühr und je Kanal-Typ Kontingent und Gebühr. Kunden bekommen ihr Paket in der Abrechnung zugewiesen."
          actions={
            <Button href={`${BASE}?panel=package`} size="sm" icon="plus" scroll={false}>
              Neues Paket
            </Button>
          }
        >
          {packages.length === 0 ? (
            <EmptyState
              title="Noch keine Pakete"
              text="Ein Paket bündelt Grundgebühr, Kanal-Kontingente und eine Preisliste."
            />
          ) : null}
          {packages.map((pkg) => {
            const formId = `pkg-${pkg.id}`;
            return (
              <div className="pricing-item" key={pkg.id}>
                <div className="row row--between">
                  <div className="row grow">
                    <input
                      form={formId}
                      name="name"
                      type="text"
                      required
                      minLength={2}
                      maxLength={80}
                      defaultValue={pkg.name}
                      aria-label="Name des Pakets"
                      className="pricing-item-name"
                    />
                    {pkg.isActive ? (
                      <Badge tone="success" dot>
                        Aktiv
                      </Badge>
                    ) : (
                      <Badge tone="muted" dot>
                        Inaktiv
                      </Badge>
                    )}
                  </div>
                  <div className="row">
                    <Button type="submit" form={formId} size="sm">
                      Speichern
                    </Button>
                    <Menu label={`Aktionen für Paket ${pkg.name}`}>
                      <form action={deletePackage}>
                        <input type="hidden" name="id" value={pkg.id} />
                        <button className="menu-item menu-item--danger" type="submit">
                          <span className="menu-label">Paket löschen</span>
                        </button>
                      </form>
                    </Menu>
                  </div>
                </div>

                <form id={formId} action={updatePackage} className="stack">
                  <input type="hidden" name="id" value={pkg.id} />
                  <div className="field-row">
                    <Field label="Preisliste" htmlFor={`${formId}-tier`}>
                      <select
                        id={`${formId}-tier`}
                        name="priceTierId"
                        defaultValue={pkg.priceTierId ?? ''}
                      >
                        <option value="">Standard</option>
                        {priceLists.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Setup-Gebühr in €, einmalig" htmlFor={`${formId}-setup`}>
                      <input
                        id={`${formId}-setup`}
                        name="setupFeeEur"
                        type="text"
                        inputMode="decimal"
                        defaultValue={String(pkg.setupFeeEur)}
                      />
                    </Field>
                    <Field label="Grundgebühr pro Monat in €" htmlFor={`${formId}-month`}>
                      <input
                        id={`${formId}-month`}
                        name="baseFeeMonthlyEur"
                        type="text"
                        inputMode="decimal"
                        defaultValue={String(pkg.baseFeeMonthlyEur)}
                      />
                    </Field>
                    <Field label="Grundgebühr pro Jahr in €" htmlFor={`${formId}-year`}>
                      <input
                        id={`${formId}-year`}
                        name="baseFeeYearlyEur"
                        type="text"
                        inputMode="decimal"
                        defaultValue={String(pkg.baseFeeYearlyEur)}
                      />
                    </Field>
                  </div>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      name="isActive"
                      className="switch"
                      defaultChecked={pkg.isActive}
                    />
                    Aktiv, kann Kunden zugewiesen werden
                  </label>

                  <div className="table-wrap">
                    <table className="table--compact">
                      <thead>
                        <tr>
                          <th>Kanal-Typ</th>
                          <th className="right">Kontingent</th>
                          <th className="right">Gebühr pro Monat in €</th>
                          <th className="right">Gebühr pro Jahr in €</th>
                        </tr>
                      </thead>
                      <tbody>
                        {PACKAGE_CHANNEL_KINDS.map((kind) => {
                          const term = pkg.channels[kind];
                          const label = PACKAGE_CHANNEL_LABELS[kind];
                          return (
                            <tr key={kind}>
                              <td>{label}</td>
                              <td className="right">
                                <input
                                  name={`quota_${kind}`}
                                  type="text"
                                  inputMode="numeric"
                                  placeholder="0"
                                  defaultValue={term ? String(term.quota) : ''}
                                  aria-label={`Kontingent ${label}`}
                                  className="num-input num-input--sm"
                                />
                              </td>
                              <td className="right">
                                <input
                                  name={`feem_${kind}`}
                                  type="text"
                                  inputMode="decimal"
                                  placeholder="0"
                                  defaultValue={term ? String(term.feeMonthlyEur) : ''}
                                  aria-label={`Gebühr pro Monat ${label}`}
                                  className="num-input"
                                />
                              </td>
                              <td className="right">
                                <input
                                  name={`feey_${kind}`}
                                  type="text"
                                  inputMode="decimal"
                                  placeholder="0"
                                  defaultValue={term ? String(term.feeYearlyEur) : ''}
                                  aria-label={`Gebühr pro Jahr ${label}`}
                                  className="num-input"
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </form>
                <p className="field-help">
                  Aktuell gespeichert: <strong>{formatEur(packageMonthlyTotalEur(pkg))} pro Monat</strong>
                  {' · '}
                  <strong>{formatEur(packageYearlyTotalEur(pkg))} pro Jahr</strong>, dazu Setup{' '}
                  {formatEur(pkg.setupFeeEur)}.
                </p>
              </div>
            );
          })}
        </Section>
      </div>

      {newList ? (
        <Drawer
          title="Neue Preisliste"
          closeHref={BASE}
          footer={
            <>
              <Button href={BASE} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="new-list" variant="primary">
                Preisliste anlegen
              </Button>
            </>
          }
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <form id="new-list" action={createPriceList} className="stack">
            <Field
              label="Name"
              htmlFor="new-list-name"
              help="Die Preise trägst du nach dem Anlegen ein."
            >
              <input
                id="new-list-name"
                name="name"
                type="text"
                required
                minLength={2}
                maxLength={80}
                placeholder="z. B. Partner"
              />
            </Field>
          </form>
        </Drawer>
      ) : null}

      {newPackage ? (
        <Drawer
          title="Neues Paket"
          closeHref={BASE}
          footer={
            <>
              <Button href={BASE} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="new-package" variant="primary">
                Paket anlegen
              </Button>
            </>
          }
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <form id="new-package" action={createPackage} className="stack">
            <Field
              label="Name"
              htmlFor="new-pkg-name"
              help="Gebühren und Kontingente trägst du nach dem Anlegen ein."
            >
              <input
                id="new-pkg-name"
                name="name"
                type="text"
                required
                minLength={2}
                maxLength={80}
                placeholder="z. B. Starter"
              />
            </Field>
          </form>
        </Drawer>
      ) : null}
    </div>
  );
}
