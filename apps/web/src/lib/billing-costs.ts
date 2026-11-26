import 'server-only';
import {
  BILLING_CATEGORY_BILLING_LABEL,
  BILLING_CATEGORY_LABELS,
  BILLING_CATEGORY_ORDER,
  UNIT_PRICED_CATEGORIES,
  hasPurchaseCost,
  priceUnitWords,
  unitCostEur,
  type BillingCategory,
  type PricingContext,
  type SupabaseClient,
  type TierPricing,
  type UnitPricedCategory,
} from '@zendori/core';

// What a price position costs US (Einkauf) — for the admin pricing pages only.
// Platform-admin, service role. Never shown to a customer.

type TokenCategory = 'ai' | 'embeddings' | 'transcription';
export type AvgTokenCosts = Partial<Record<TokenCategory, number>>;

/** Which ai_runs steps roll up into which token category (mirrors billing_org_rollup). */
const STEP_CATEGORY: Record<string, TokenCategory> = {
  classify: 'ai',
  extract: 'ai',
  draft: 'ai',
  rerank: 'ai',
  learn: 'ai',
  retrieve: 'embeddings',
  transcribe: 'transcription',
};

const isUnitPriced = (category: BillingCategory): category is UnitPricedCategory =>
  (UNIT_PRICED_CATEGORIES as readonly string[]).includes(category);

/** A unit amount with up to four decimals (a single KI-Vorgang costs fractions of a cent). */
export function formatUnitEur(value: number): string {
  return `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)} €`;
}

/**
 * Ø purchase cost per Vorgang for the token categories, from recent samples.
 * Mirrors billing_org_rollup's Vorgang definition: ai_runs rows for the mapped
 * steps PLUS index_embeddings usage_events (each event = one Vorgang covering a
 * whole source index — these dominate the embeddings average and must not be
 * omitted, or the unter-Einkauf check would approve loss-making prices).
 * Display-only; a category without data is reported as absent.
 */
export async function loadAvgTokenCosts(
  admin: SupabaseClient,
  usdToEur: number
): Promise<AvgTokenCosts> {
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
  const out: AvgTokenCosts = {};
  for (const key of ['ai', 'embeddings', 'transcription'] as const) {
    const bucket = sums[key];
    if (bucket && bucket.count > 0) out[key] = (bucket.total / bucket.count) * usdToEur;
  }
  return out;
}

/** Our purchase cost per unit in EUR; 0 = nothing is bought in; null = no data yet. */
export function purchaseCostEur(
  category: BillingCategory,
  ctx: PricingContext,
  avg: AvgTokenCosts
): number | null {
  // e.g. data actions: they run on the customer's own system, nothing is bought in
  if (!hasPurchaseCost(category)) return 0;
  if (isUnitPriced(category)) return unitCostEur(category, ctx);
  return avg[category as TokenCategory] ?? null;
}

export function purchaseCostLabel(
  category: BillingCategory,
  ctx: PricingContext,
  avg: AvgTokenCosts
): string {
  if (!hasPurchaseCost(category)) return 'kein Einkauf';
  if (isUnitPriced(category)) return formatUnitEur(unitCostEur(category, ctx));
  const value = avg[category as TokenCategory];
  return value !== undefined ? `Ø ${formatUnitEur(value)}` : 'noch keine Daten';
}

/** One price position with everything a pricing table or editor shows about it. */
export interface PricePosition {
  category: BillingCategory;
  label: string;
  /** "je Minute", "je Nummer und Monat" … */
  unitWords: string;
  /** "transaktionell" | "monatlich" */
  billing: string;
  /** false = nothing is bought in (data actions). */
  hasCost: boolean;
  /** null = no data yet for an averaged position. */
  costEur: number | null;
  costLabel: string;
  /** The list's sell price; null = not priced (passed on at purchase cost). */
  priceEur: number | null;
}

/** The nine positions of a price list, in display order. */
export function pricePositions(
  pricing: TierPricing,
  ctx: PricingContext,
  avg: AvgTokenCosts
): PricePosition[] {
  return BILLING_CATEGORY_ORDER.map((category) => {
    const rule = pricing[category];
    return {
      category,
      label: BILLING_CATEGORY_LABELS[category],
      unitWords: priceUnitWords(category),
      billing: BILLING_CATEGORY_BILLING_LABEL[category],
      hasCost: hasPurchaseCost(category),
      costEur: purchaseCostEur(category, ctx, avg),
      costLabel: purchaseCostLabel(category, ctx, avg),
      priceEur: rule?.mode === 'unit' ? rule.unitPriceEur : null,
    };
  });
}

/** Positions whose sell price is below what they cost us. */
export function belowCostCount(positions: PricePosition[]): number {
  return positions.filter(
    (p) => p.priceEur !== null && p.costEur !== null && p.priceEur < p.costEur
  ).length;
}

/** Positions without a sell price (passed on at cost; data actions: not charged). */
export function unpricedCount(positions: PricePosition[]): number {
  return positions.filter((p) => p.priceEur === null).length;
}
