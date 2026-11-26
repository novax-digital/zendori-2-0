import 'server-only';
import {
  BILLING_CATEGORY_LABELS,
  BILLING_CATEGORY_UNIT,
  DEFAULT_NUMBER_COST_LANDLINE_EUR,
  DEFAULT_NUMBER_COST_MOBILE_EUR,
  DEFAULT_USD_TO_EUR,
  NO_OWN_TERMS,
  PACKAGE_CHANNEL_KINDS,
  categoryPriceEur,
  effectivePricing,
  emailCostUsd,
  isMissingColumnError,
  packageChannelsSchema,
  priceTierPricingSchema,
  recurringFeeLines,
  resolveTerms,
  subscriptionOwnChannelsSchema,
  whatsappCostUsd,
  type BillingCategory,
  type BillingInterval,
  type EffectiveTerms,
  type PackageChannels,
  type PackageTerms,
  type PricingContext,
  type SubscriptionOwnTerms,
  type SupabaseClient,
  type TierPricing,
} from '@zendori/core';

// Billing rollup + invoicing (migrations 0021/0022). Runs only in guarded
// service-role server code (admin: platform_admins; customer: verified org
// membership). Combines usage (billing_org_rollup) priced through the org's tier
// with the recurring package fees. Returns €-amounts + quantities; our raw USD
// cost and the margin never reach the customer client.

const MS_PER_DAY = 86_400_000;
const round2 = (value: number): number => Math.round(value * 100) / 100;

const CATEGORY_ORDER: BillingCategory[] = [
  'ai',
  'embeddings',
  'transcription',
  'voice',
  'whatsapp',
  'email',
  'numbers_mobile',
  'numbers_landline',
  'data_actions',
];

// --- usage breakdown ---------------------------------------------------------

export interface BillingLineItem {
  category: BillingCategory;
  label: string;
  unit: string;
  quantity: number;
  /** Our internal USD cost — admin-only, never shown to the customer. */
  costUsd: number;
  priceEur: number;
}

export interface BillingBreakdown {
  orgId: string;
  fromIso: string;
  toIso: string;
  lines: BillingLineItem[];
  totalCostUsd: number;
  totalPriceEur: number;
}

type RollupRow = { category: string; quantity: number | string; cost_usd: number | string };

/**
 * Aggregate one org's usage for [fromIso, toIso) and price it through `tier`
 * (free EUR unit price per position; unpriced position ⇒ pass-through at cost,
 * displayed in EUR via the fixed internal conversion in `ctx`).
 */
export async function getOrgBilling(
  admin: SupabaseClient,
  orgId: string,
  fromIso: string,
  toIso: string,
  ctx: PricingContext,
  tier: TierPricing | null
): Promise<BillingBreakdown> {
  const periodDays = Math.max(0, (Date.parse(toIso) - Date.parse(fromIso)) / MS_PER_DAY);

  const raw = new Map<string, { quantity: number; costUsd: number }>();
  const { data, error } = await admin.rpc('billing_org_rollup', {
    p_org_id: orgId,
    p_from: fromIso,
    p_to: toIso,
  });
  if (!error && Array.isArray(data)) {
    for (const row of data as RollupRow[]) {
      raw.set(row.category, {
        quantity: Number(row.quantity) || 0,
        costUsd: Number(row.cost_usd) || 0,
      });
    }
  }
  const get = (key: string): { quantity: number; costUsd: number } =>
    raw.get(key) ?? { quantity: 0, costUsd: 0 };

  const wa = get('whatsapp_count');
  const em = get('email_count');
  const mob = get('numbers_mobile_count');
  const land = get('numbers_landline_count');
  // Number costs are configured in EUR (billing_settings); represent them as a
  // synthetic costUsd (÷ usd_to_eur) so the shared cost/price math stays uniform.
  const monthsFraction = periodDays / 30;
  const numberCostUsd = (count: number, monthlyEur: number): number =>
    ctx.usdToEur > 0 ? (count * monthlyEur * monthsFraction) / ctx.usdToEur : 0;
  const byCategory: Record<BillingCategory, { quantity: number; costUsd: number }> = {
    ai: get('ai'),
    embeddings: get('embeddings'),
    transcription: get('transcription'),
    voice: get('voice'),
    whatsapp: { quantity: wa.quantity, costUsd: whatsappCostUsd(wa.quantity) },
    email: { quantity: em.quantity, costUsd: emailCostUsd(em.quantity) },
    numbers_mobile: {
      quantity: mob.quantity,
      costUsd: numberCostUsd(mob.quantity, ctx.numberCostMobileEur),
    },
    numbers_landline: {
      quantity: land.quantity,
      costUsd: numberCostUsd(land.quantity, ctx.numberCostLandlineEur),
    },
    // counted in the usage ledger by a trigger on action_runs (0040); no purchase
    // cost — the row is absent before the migration and then simply 0
    data_actions: { quantity: get('data_actions').quantity, costUsd: 0 },
  };

  const lines: BillingLineItem[] = CATEGORY_ORDER.map((category) => {
    const { quantity, costUsd } = byCategory[category];
    return {
      category,
      label: BILLING_CATEGORY_LABELS[category],
      unit: BILLING_CATEGORY_UNIT[category],
      quantity,
      costUsd,
      priceEur: categoryPriceEur(quantity, costUsd, tier?.[category], ctx),
    };
  });

  const totalCostUsd = lines.reduce((sum, line) => sum + line.costUsd, 0);
  const totalPriceEur = round2(lines.reduce((sum, line) => sum + line.priceEur, 0));

  return { orgId, fromIso, toIso, lines, totalCostUsd, totalPriceEur };
}

// --- pricing catalog (tiers, packages, subscriptions) ------------------------

export interface PriceTier {
  id: string;
  name: string;
  isDefault: boolean;
  pricing: TierPricing;
}

export interface PackageRow {
  id: string;
  name: string;
  priceTierId: string | null;
  setupFeeEur: number;
  baseFeeMonthlyEur: number;
  /** Stored for older code only (0042): the year follows from month + discount. */
  baseFeeYearlyEur: number;
  /** Discount on a yearly term in percent (0042; 0 before the migration). */
  yearlyDiscountPercent: number;
  channels: PackageChannels;
  isActive: boolean;
}

export interface SubscriptionRow {
  orgId: string;
  packageId: string | null;
  priceTierId: string | null;
  interval: BillingInterval;
  setupFeeEur: number | null;
  startedAt: string;
  /** The customer's own values (0042); everything empty = exactly the package. */
  own: SubscriptionOwnTerms;
}

export interface BillingCatalog {
  ctx: PricingContext;
  tiers: Map<string, PriceTier>;
  defaultTier: PriceTier | null;
  packages: Map<string, PackageRow>;
  subscriptions: Map<string, SubscriptionRow>;
}

const FALLBACK_CONTEXT: PricingContext = {
  usdToEur: DEFAULT_USD_TO_EUR,
  numberCostMobileEur: DEFAULT_NUMBER_COST_MOBILE_EUR,
  numberCostLandlineEur: DEFAULT_NUMBER_COST_LANDLINE_EUR,
};

const posNum = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

async function loadContext(admin: SupabaseClient): Promise<PricingContext> {
  // usd_to_eur is a fixed internal constant now (owner: no FX editing in the
  // UI); only the number purchase costs are read from billing_settings.
  const { data, error } = await admin
    .from('billing_settings')
    .select('number_cost_mobile_eur, number_cost_landline_eur')
    .is('org_id', null)
    .maybeSingle();
  if (error || !data) return FALLBACK_CONTEXT;
  const row = data as Record<string, number | string>;
  return {
    usdToEur: DEFAULT_USD_TO_EUR,
    numberCostMobileEur: posNum(row.number_cost_mobile_eur, DEFAULT_NUMBER_COST_MOBILE_EUR),
    numberCostLandlineEur: posNum(row.number_cost_landline_eur, DEFAULT_NUMBER_COST_LANDLINE_EUR),
  };
}

function parseTier(row: {
  id: string;
  name: string;
  is_default: boolean;
  pricing: unknown;
}): PriceTier {
  const parsed = priceTierPricingSchema.safeParse(row.pricing ?? {});
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default,
    pricing: parsed.success ? (parsed.data as TierPricing) : {},
  };
}

function parsePackage(row: {
  id: string;
  name: string;
  price_tier_id: string | null;
  setup_fee_eur: number | string;
  base_fee_monthly_eur: number | string;
  base_fee_yearly_eur: number | string;
  yearly_discount_percent?: number | string | null;
  channels: unknown;
  is_active: boolean;
}): PackageRow {
  const channels = packageChannelsSchema.safeParse(row.channels ?? {});
  return {
    id: row.id,
    name: row.name,
    priceTierId: row.price_tier_id,
    setupFeeEur: Number(row.setup_fee_eur) || 0,
    baseFeeMonthlyEur: Number(row.base_fee_monthly_eur) || 0,
    baseFeeYearlyEur: Number(row.base_fee_yearly_eur) || 0,
    yearlyDiscountPercent: Number(row.yearly_discount_percent) || 0,
    channels: channels.success ? (channels.data as PackageChannels) : {},
    isActive: row.is_active,
  };
}

/** Load tiers, packages and subscriptions once (all skew-tolerant → empty pre-0022). */
export async function loadBillingCatalog(admin: SupabaseClient): Promise<BillingCatalog> {
  const ctx = await loadContext(admin);
  const catalog: BillingCatalog = {
    ctx,
    tiers: new Map(),
    defaultTier: null,
    packages: new Map(),
    subscriptions: new Map(),
  };

  const { data: tierData } = await admin
    .from('price_tiers')
    .select('id, name, is_default, pricing');
  for (const row of (tierData ?? []) as Parameters<typeof parseTier>[0][]) {
    const tier = parseTier(row);
    catalog.tiers.set(tier.id, tier);
    if (tier.isDefault) catalog.defaultTier = tier;
  }

  // The 0042 columns (yearly discount, a customer's own values) may not exist
  // yet: a missing column falls back to the columns that always existed, so a
  // deploy ahead of the migration bills exactly as before.
  let { data: pkgData, error: pkgError } = await admin
    .from('packages')
    .select(`${PACKAGE_COLUMNS}, yearly_discount_percent`);
  if (pkgError && isMissingColumnError(pkgError)) {
    ({ data: pkgData, error: pkgError } = await admin.from('packages').select(PACKAGE_COLUMNS));
  }
  for (const row of (pkgData ?? []) as unknown as Parameters<typeof parsePackage>[0][]) {
    const pkg = parsePackage(row);
    catalog.packages.set(pkg.id, pkg);
  }

  let { data: subData, error: subError } = await admin
    .from('org_subscriptions')
    .select(
      `${SUBSCRIPTION_COLUMNS}, base_fee_monthly_eur, yearly_discount_percent, channels, pricing`
    );
  if (subError && isMissingColumnError(subError)) {
    ({ data: subData, error: subError } = await admin
      .from('org_subscriptions')
      .select(SUBSCRIPTION_COLUMNS));
  }
  for (const row of (subData ?? []) as unknown as SubscriptionDbRow[]) {
    const setupFeeEur = row.setup_fee_eur === null ? null : Number(row.setup_fee_eur);
    catalog.subscriptions.set(row.org_id, {
      orgId: row.org_id,
      packageId: row.package_id,
      priceTierId: row.price_tier_id,
      interval: row.billing_interval === 'yearly' ? 'yearly' : 'monthly',
      setupFeeEur,
      startedAt: row.started_at,
      own: parseOwnTerms(row, setupFeeEur),
    });
  }

  return catalog;
}

const PACKAGE_COLUMNS =
  'id, name, price_tier_id, setup_fee_eur, base_fee_monthly_eur, base_fee_yearly_eur, channels, is_active';
const SUBSCRIPTION_COLUMNS =
  'org_id, package_id, price_tier_id, billing_interval, setup_fee_eur, started_at';

interface SubscriptionDbRow {
  org_id: string;
  package_id: string | null;
  price_tier_id: string | null;
  billing_interval: BillingInterval;
  setup_fee_eur: number | string | null;
  started_at: string;
  base_fee_monthly_eur?: number | string | null;
  yearly_discount_percent?: number | string | null;
  channels?: unknown;
  pricing?: unknown;
}

/** null/absent → null; a stored number (0 included) stays a number. */
const ownNumber = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** A customer's own values out of the subscription row (0042 columns optional). */
function parseOwnTerms(row: SubscriptionDbRow, setupFeeEur: number | null): SubscriptionOwnTerms {
  const channels = subscriptionOwnChannelsSchema.safeParse(row.channels ?? {});
  const pricing = priceTierPricingSchema.safeParse(row.pricing ?? {});
  return {
    ...NO_OWN_TERMS,
    setupFeeEur,
    baseFeeMonthlyEur: ownNumber(row.base_fee_monthly_eur),
    yearlyDiscountPercent: ownNumber(row.yearly_discount_percent),
    channels: channels.success ? channels.data : {},
    pricing: pricing.success ? (pricing.data as TierPricing) : {},
  };
}

/** The price list that applies to an org: subscription list → package list → default. */
export function resolveOrgPriceList(catalog: BillingCatalog, orgId: string): PriceTier | null {
  const sub = catalog.subscriptions.get(orgId);
  const pkg = sub?.packageId ? catalog.packages.get(sub.packageId) : undefined;
  const tierId = sub?.priceTierId ?? pkg?.priceTierId ?? catalog.defaultTier?.id ?? null;
  const tier = tierId ? catalog.tiers.get(tierId) : catalog.defaultTier;
  return tier ?? null;
}

/**
 * The unit prices that apply to an org: its price list (see above) with the
 * customer's own unit prices on top (0042).
 */
export function resolveOrgTier(catalog: BillingCatalog, orgId: string): TierPricing | null {
  const list = resolveOrgPriceList(catalog, orgId);
  const own = catalog.subscriptions.get(orgId)?.own.pricing ?? {};
  return effectivePricing(list?.pricing ?? null, own);
}

/** The fixed part of a package in the shape the terms math works with. */
export function packageTermsOf(pkg: PackageRow): PackageTerms {
  const channels: PackageTerms['channels'] = {};
  for (const kind of PACKAGE_CHANNEL_KINDS) {
    const term = pkg.channels[kind];
    if (term) channels[kind] = { quota: term.quota, feeMonthlyEur: term.feeMonthlyEur };
  }
  return {
    setupFeeEur: pkg.setupFeeEur,
    baseFeeMonthlyEur: pkg.baseFeeMonthlyEur,
    yearlyDiscountPercent: pkg.yearlyDiscountPercent,
    channels,
  };
}

/** What applies to an org: its package with the org's own values on top; null without a package. */
export function resolveOrgTerms(catalog: BillingCatalog, orgId: string): EffectiveTerms | null {
  const sub = catalog.subscriptions.get(orgId);
  const pkg = sub?.packageId ? catalog.packages.get(sub.packageId) : undefined;
  if (!sub || !pkg) return null;
  return resolveTerms(packageTermsOf(pkg), sub.own);
}

// --- combined invoice --------------------------------------------------------

export interface RecurringLine {
  /** `base`, `channel:<kind>` or `setup`. */
  key: string;
  label: string;
  amountEur: number;
}

export interface OrgInvoice {
  usage: BillingBreakdown;
  recurring: RecurringLine[];
  recurringTotalEur: number;
  setupEur: number;
  grandTotalEur: number;
  packageName: string | null;
  interval: BillingInterval | null;
}

/** Does the given month contain the subscription's start (for the one-time setup fee)? */
function isSetupMonth(startedAtIso: string, fromIso: string, toIso: string): boolean {
  const start = Date.parse(startedAtIso);
  return Number.isFinite(start) && start >= Date.parse(fromIso) && start < Date.parse(toIso);
}

/** Full invoice for one org + month: usage (tier-priced) + recurring + setup. */
export async function getOrgInvoice(
  admin: SupabaseClient,
  orgId: string,
  period: MonthPeriod,
  catalog: BillingCatalog
): Promise<OrgInvoice> {
  const tier = resolveOrgTier(catalog, orgId);
  const usage = await getOrgBilling(admin, orgId, period.fromIso, period.toIso, catalog.ctx, tier);

  const sub = catalog.subscriptions.get(orgId);
  const pkg = sub?.packageId ? catalog.packages.get(sub.packageId) : undefined;

  let recurring: RecurringLine[] = [];
  let setupEur = 0;
  let packageName: string | null = null;
  let interval: BillingInterval | null = null;

  if (sub && pkg) {
    interval = sub.interval;
    packageName = pkg.name;
    // package + the customer's own values; on a yearly term each month carries
    // the monthly price minus the discount (core: recurringFeeLines)
    const terms = resolveTerms(packageTermsOf(pkg), sub.own);
    recurring = recurringFeeLines(terms, sub.interval);
    if (isSetupMonth(sub.startedAt, period.fromIso, period.toIso)) {
      setupEur = round2(terms.setupFeeEur);
      if (setupEur > 0) {
        recurring.push({ key: 'setup', label: 'Einrichtung (einmalig)', amountEur: setupEur });
      }
    }
  }

  const recurringTotalEur = round2(recurring.reduce((sum, line) => sum + line.amountEur, 0));
  const grandTotalEur = round2(usage.totalPriceEur + recurringTotalEur);

  return {
    usage,
    recurring,
    recurringTotalEur,
    setupEur,
    grandTotalEur,
    packageName,
    interval,
  };
}

// --- period helpers ----------------------------------------------------------

const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export interface MonthPeriod {
  key: string;
  label: string;
  fromIso: string;
  toIso: string;
}

export function monthPeriod(year: number, month: number): MonthPeriod {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  return {
    key: `${year}-${String(month).padStart(2, '0')}`,
    label: `${MONTH_NAMES_DE[month - 1]} ${year}`,
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
  };
}

export function currentMonth(now: Date): MonthPeriod {
  return monthPeriod(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

export function parseMonthKey(key: string | undefined, fallback: MonthPeriod): MonthPeriod {
  const match = key?.match(/^(\d{4})-(\d{2})$/);
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    if (m >= 1 && m <= 12) return monthPeriod(y, m);
  }
  return fallback;
}

export function recentMonths(now: Date, count: number): MonthPeriod[] {
  const out: MonthPeriod[] = [];
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  for (let i = 0; i < count; i += 1) {
    let y = year;
    let m = month - i;
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    out.push(monthPeriod(y, m));
  }
  return out;
}

export function formatEur(amount: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
}

/**
 * EUR formatting for INTERNAL cost figures, where a single event is often worth
 * a fraction of a cent (one Haiku classification ≈ 0,1–0,3 Cent). Standard
 * two-decimal formatting rounds those to 0,00 € and makes real, correctly
 * metered costs look like a metering bug. Sub-cent amounts therefore get four
 * decimals; everything from one cent up renders like formatEur.
 */
export function formatEurCost(amount: number): string {
  const subCent = amount !== 0 && Math.abs(amount) < 0.005;
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: subCent ? 4 : 2,
  }).format(amount);
}

export function formatQuantity(quantity: number, unit: string): string {
  const rounded = unit === 'Minuten' ? Math.round(quantity * 10) / 10 : Math.round(quantity);
  return `${new Intl.NumberFormat('de-DE').format(rounded)} ${unit}`;
}
