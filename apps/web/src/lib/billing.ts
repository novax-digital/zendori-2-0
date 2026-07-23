import 'server-only';
import {
  BILLING_CATEGORY_LABELS,
  BILLING_CATEGORY_UNIT,
  DEFAULT_NUMBER_COST_LANDLINE_EUR,
  DEFAULT_NUMBER_COST_MOBILE_EUR,
  DEFAULT_USD_TO_EUR,
  PACKAGE_CHANNEL_KINDS,
  PACKAGE_CHANNEL_LABELS,
  categoryPriceEur,
  emailCostUsd,
  packageChannelsSchema,
  priceTierPricingSchema,
  whatsappCostUsd,
  type BillingCategory,
  type BillingInterval,
  type PackageChannels,
  type PricingContext,
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
  baseFeeYearlyEur: number;
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

  const { data: pkgData } = await admin
    .from('packages')
    .select('id, name, price_tier_id, setup_fee_eur, base_fee_monthly_eur, base_fee_yearly_eur, channels, is_active');
  for (const row of (pkgData ?? []) as Parameters<typeof parsePackage>[0][]) {
    const pkg = parsePackage(row);
    catalog.packages.set(pkg.id, pkg);
  }

  const { data: subData } = await admin
    .from('org_subscriptions')
    .select('org_id, package_id, price_tier_id, billing_interval, setup_fee_eur, started_at');
  for (const row of (subData ?? []) as {
    org_id: string;
    package_id: string | null;
    price_tier_id: string | null;
    billing_interval: BillingInterval;
    setup_fee_eur: number | string | null;
    started_at: string;
  }[]) {
    catalog.subscriptions.set(row.org_id, {
      orgId: row.org_id,
      packageId: row.package_id,
      priceTierId: row.price_tier_id,
      interval: row.billing_interval === 'yearly' ? 'yearly' : 'monthly',
      setupFeeEur: row.setup_fee_eur === null ? null : Number(row.setup_fee_eur),
      startedAt: row.started_at,
    });
  }

  return catalog;
}

/** The tier pricing that applies to an org: subscription tier → package tier → default. */
export function resolveOrgTier(catalog: BillingCatalog, orgId: string): TierPricing | null {
  const sub = catalog.subscriptions.get(orgId);
  const pkg = sub?.packageId ? catalog.packages.get(sub.packageId) : undefined;
  const tierId = sub?.priceTierId ?? pkg?.priceTierId ?? catalog.defaultTier?.id ?? null;
  const tier = tierId ? catalog.tiers.get(tierId) : catalog.defaultTier;
  return tier?.pricing ?? null;
}

// --- combined invoice --------------------------------------------------------

export interface RecurringLine {
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

/** Recurring fee lines for a package (monthly-equivalent; yearly shown ÷12). */
function recurringLines(pkg: PackageRow, interval: BillingInterval): RecurringLine[] {
  const yearly = interval === 'yearly';
  const lines: RecurringLine[] = [];
  const base = yearly ? pkg.baseFeeYearlyEur / 12 : pkg.baseFeeMonthlyEur;
  if (base > 0) {
    lines.push({
      label: yearly ? 'Grundgebühr (jährlich, anteilig)' : 'Grundgebühr',
      amountEur: round2(base),
    });
  }
  for (const kind of PACKAGE_CHANNEL_KINDS) {
    const term = pkg.channels[kind];
    if (!term || term.quota <= 0) continue;
    const fee = yearly ? term.feeYearlyEur / 12 : term.feeMonthlyEur;
    const amount = round2(term.quota * fee);
    if (amount <= 0) continue;
    lines.push({ label: `${PACKAGE_CHANNEL_LABELS[kind]} (${term.quota}×)`, amountEur: amount });
  }
  return lines;
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
    recurring = recurringLines(pkg, sub.interval);
    if (isSetupMonth(sub.startedAt, period.fromIso, period.toIso)) {
      setupEur = round2(sub.setupFeeEur ?? pkg.setupFeeEur);
      if (setupEur > 0) recurring.push({ label: 'Einrichtung (einmalig)', amountEur: setupEur });
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

export function formatQuantity(quantity: number, unit: string): string {
  const rounded = unit === 'Minuten' ? Math.round(quantity * 10) / 10 : Math.round(quantity);
  return `${new Intl.NumberFormat('de-DE').format(rounded)} ${unit}`;
}
