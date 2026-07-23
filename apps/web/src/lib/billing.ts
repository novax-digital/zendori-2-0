import 'server-only';
import {
  BILLING_CATEGORY_LABELS,
  BILLING_CATEGORY_UNIT,
  DEFAULT_PRICING,
  emailCostUsd,
  numberRentalCostUsd,
  priceEur,
  whatsappCostUsd,
  type BillingCategory,
  type BillingPricing,
  type SupabaseClient,
} from '@zendori/core';

// Billing rollup (migration 0021). Runs only in guarded service-role server code
// (admin: platform_admins; customer: verified org membership). Combines the
// server-side aggregation (billing_org_rollup: ai_runs + usage_events sums,
// message/channel counts) with the rate card for count-priced categories and the
// per-org markup/FX. Returns €-amounts + usage quantities; our raw USD cost stays
// server-side (callers decide whether to surface it — the customer page never does).

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

const MS_PER_DAY = 86_400_000;
const CATEGORY_ORDER: BillingCategory[] = [
  'ai',
  'embeddings',
  'transcription',
  'voice',
  'whatsapp',
  'email',
  'numbers',
];

type RollupRow = { category: string; quantity: number | string; cost_usd: number | string };

/** Aggregate one org's usage for [fromIso, toIso) and price it with `pricing`. */
export async function getOrgBilling(
  admin: SupabaseClient,
  orgId: string,
  fromIso: string,
  toIso: string,
  pricing: BillingPricing = DEFAULT_PRICING
): Promise<BillingBreakdown> {
  const periodDays = Math.max(0, (Date.parse(toIso) - Date.parse(fromIso)) / MS_PER_DAY);

  const raw = new Map<string, { quantity: number; costUsd: number }>();
  const { data, error } = await admin.rpc('billing_org_rollup', {
    p_org_id: orgId,
    p_from: fromIso,
    p_to: toIso,
  });
  // On error (function absent pre-migration, transient) fall through to all-zeros.
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

  // Measured categories carry their own cost; count-priced categories apply the
  // rate card here so all prices live in packages/core/src/billing.ts.
  const wa = get('whatsapp_count');
  const em = get('email_count');
  const num = get('numbers_count');
  const byCategory: Record<BillingCategory, { quantity: number; costUsd: number }> = {
    ai: get('ai'),
    embeddings: get('embeddings'),
    transcription: get('transcription'),
    voice: get('voice'),
    whatsapp: { quantity: wa.quantity, costUsd: whatsappCostUsd(wa.quantity) },
    email: { quantity: em.quantity, costUsd: emailCostUsd(em.quantity) },
    numbers: { quantity: num.quantity, costUsd: numberRentalCostUsd(num.quantity, periodDays) },
  };

  const lines: BillingLineItem[] = CATEGORY_ORDER.map((category) => {
    const { quantity, costUsd } = byCategory[category];
    return {
      category,
      label: BILLING_CATEGORY_LABELS[category],
      unit: BILLING_CATEGORY_UNIT[category],
      quantity,
      costUsd,
      priceEur: priceEur(costUsd, pricing),
    };
  });

  const totalCostUsd = lines.reduce((sum, line) => sum + line.costUsd, 0);
  const totalPriceEur = Math.round(lines.reduce((sum, line) => sum + line.priceEur, 0) * 100) / 100;

  return { orgId, fromIso, toIso, lines, totalCostUsd, totalPriceEur };
}

/** Loaded once per request: resolve a per-org override or the global default. */
export interface PricingResolver {
  global: BillingPricing;
  forOrg: (orgId: string) => BillingPricing;
}

export async function loadPricing(admin: SupabaseClient): Promise<PricingResolver> {
  let global = DEFAULT_PRICING;
  const perOrg = new Map<string, BillingPricing>();

  const { data, error } = await admin
    .from('billing_settings')
    .select('org_id, markup_factor, usd_to_eur');
  if (!error) {
    for (const row of (data ?? []) as {
      org_id: string | null;
      markup_factor: number | string;
      usd_to_eur: number | string;
    }[]) {
      const usdToEur = Number(row.usd_to_eur);
      const markupFactor = Number(row.markup_factor);
      const pricing: BillingPricing = {
        usdToEur: Number.isFinite(usdToEur) && usdToEur > 0 ? usdToEur : DEFAULT_PRICING.usdToEur,
        markupFactor:
          Number.isFinite(markupFactor) && markupFactor >= 0
            ? markupFactor
            : DEFAULT_PRICING.markupFactor,
      };
      if (row.org_id === null) global = pricing;
      else perOrg.set(row.org_id, pricing);
    }
  }

  return { global, forOrg: (orgId: string) => perOrg.get(orgId) ?? global };
}

// --- period helpers ----------------------------------------------------------

const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export interface MonthPeriod {
  /** e.g. "2026-07" — the selector value. */
  key: string;
  label: string;
  fromIso: string;
  toIso: string;
}

/** UTC month boundaries for `year`/`month` (month 1-12). */
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

/** The calendar month containing `now` (UTC). */
export function currentMonth(now: Date): MonthPeriod {
  return monthPeriod(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

/** Parse a "YYYY-MM" selector value; falls back to the given current month. */
export function parseMonthKey(key: string | undefined, fallback: MonthPeriod): MonthPeriod {
  const match = key?.match(/^(\d{4})-(\d{2})$/);
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    if (m >= 1 && m <= 12) return monthPeriod(y, m);
  }
  return fallback;
}

/** The last `count` months (newest first), starting from the given now. */
export function recentMonths(now: Date, count: number): MonthPeriod[] {
  const out: MonthPeriod[] = [];
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12
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
