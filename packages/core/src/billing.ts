import { z } from 'zod';

// Billing rate card + pricing helpers (single source of truth, CLAUDE.md-style
// "Grundlage fürs Pricing"). All monetary values here are provider LIST PRICES
// in USD and are ASSUMPTIONS to be verified against the signed contracts before
// invoicing a customer (see docs/billing.md). Anthropic/OpenAI token prices are
// not here — those are measured per call and stored in ai_runs.cost_usd
// (packages/ai/src/cost.ts). This module only holds the infra rates that are
// billed by counted quantity (voice minutes, WhatsApp/e-mail messages, number
// rental) plus the FX + markup used to turn our USD cost into a customer €.

/**
 * Usage positions: what is counted and charged per unit (the "Verbrauchspreisliste").
 * Everything that is paid per month — base fee, channels, phone numbers — is
 * part of the package instead (see NUMBER_KINDS below).
 */
export type BillingCategory =
  | 'ai' // Anthropic classify/extract/rerank/learn/draft (from ai_runs)
  | 'embeddings' // OpenAI retrieval + KB-index embeddings
  | 'transcription' // OpenAI Whisper (voice notes, from ai_runs)
  | 'voice' // live phone minutes (xAI audio + Twilio SIP)
  | 'whatsapp' // WhatsApp messages (Twilio/Meta)
  | 'email' // outbound e-mail (Resend)
  | 'data_actions'; // successful agent calls of an org's own system (Phase 13/14a)

/** German labels for the customer/admin UI. */
export const BILLING_CATEGORY_LABELS: Record<BillingCategory, string> = {
  ai: 'KI-Antworten & Klassifikation',
  embeddings: 'Wissensdatenbank-Suche & Indexierung',
  transcription: 'Sprachnachrichten-Transkription',
  voice: 'Telefonie',
  whatsapp: 'WhatsApp-Nachrichten',
  email: 'E-Mail-Versand',
  data_actions: 'Data Actions',
};

/** Unit shown next to the quantity per category. */
export const BILLING_CATEGORY_UNIT: Record<BillingCategory, string> = {
  ai: 'Vorgänge',
  embeddings: 'Vorgänge',
  transcription: 'Vorgänge',
  voice: 'Minuten',
  whatsapp: 'Nachrichten',
  email: 'E-Mails',
  data_actions: 'Aktionen',
};

// --- Infra rate card (USD; assumed list prices — verify per contract) --------

/**
 * Live voice: xAI realtime audio + Twilio inbound SIP, blended per minute.
 * Assumption — confirm the xAI voice per-minute price and the Twilio SIP inbound
 * rate for the DE number type before billing.
 */
export const VOICE_USD_PER_MINUTE = 0.35;

/** WhatsApp, blended per message (Twilio/Meta conversation pricing varies). */
export const WHATSAPP_USD_PER_MESSAGE = 0.02;

/** Outbound e-mail via Resend (≈ $20 / 100k). */
export const EMAIL_USD_PER_MESSAGE = 0.0004;

/** Monthly rental per phone number (Twilio/xAI DE number). */
export const NUMBER_USD_PER_MONTH = 2.0;

/** Default FX + markup when no billing_settings row exists. */
export const DEFAULT_USD_TO_EUR = 0.92;
export const DEFAULT_MARKUP_FACTOR = 1.0;

const DAYS_PER_BILLING_MONTH = 30;

// --- Cost helpers (quantity → our USD cost) ----------------------------------

export function voiceMinutesCostUsd(minutes: number): number {
  return Math.max(0, minutes) * VOICE_USD_PER_MINUTE;
}

export function whatsappCostUsd(messageCount: number): number {
  return Math.max(0, messageCount) * WHATSAPP_USD_PER_MESSAGE;
}

export function emailCostUsd(messageCount: number): number {
  return Math.max(0, messageCount) * EMAIL_USD_PER_MESSAGE;
}

/** Number rental prorated to the billing period (monthly rate × periodDays/30). */
export function numberRentalCostUsd(numberCount: number, periodDays: number): number {
  const months = Math.max(0, periodDays) / DAYS_PER_BILLING_MONTH;
  return Math.max(0, numberCount) * NUMBER_USD_PER_MONTH * months;
}

// --- Pricing (our USD cost → customer €) -------------------------------------

export interface BillingPricing {
  /** USD → EUR conversion rate. */
  usdToEur: number;
  /** Multiplier applied on top (>1 = margin). */
  markupFactor: number;
}

export const DEFAULT_PRICING: BillingPricing = {
  usdToEur: DEFAULT_USD_TO_EUR,
  markupFactor: DEFAULT_MARKUP_FACTOR,
};

/** Customer price in EUR for a given internal USD cost. Never negative. */
export function priceEur(costUsd: number, pricing: BillingPricing = DEFAULT_PRICING): number {
  const eur = Math.max(0, costUsd) * pricing.usdToEur * pricing.markupFactor;
  // round to whole cents
  return Math.round(eur * 100) / 100;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

// ============================================================================
// Billing v2 (migration 0022): price lists (Preislisten) + packages
// ============================================================================
//
// Deliberately simple pricing model (owner decision 2026-07-23): every position
// on a price list is a FREE per-unit sell price in EUR — no FX editing, no
// markup factors, no recommendation math. The internal USD→EUR conversion is a
// fixed constant used only to display our purchase cost in EUR. A position
// without a sell price is passed through at cost (Selbstkostenpreis) so an
// unpriced category can never silently undercharge below purchase.

/** Default editable monthly number costs in EUR (billing_settings, 0023). */
export const DEFAULT_NUMBER_COST_MOBILE_EUR = 3.0;
export const DEFAULT_NUMBER_COST_LANDLINE_EUR = 1.5;

/** Display order of the positions of a usage price list. */
export const BILLING_CATEGORY_ORDER: BillingCategory[] = [
  'ai',
  'embeddings',
  'transcription',
  'voice',
  'whatsapp',
  'email',
  'data_actions',
];

/**
 * Positions without a purchase cost: a data action runs on the CUSTOMER's own
 * system, so nothing is bought in. Without a sell price such a position is
 * simply not charged (pass-through at cost = 0 €).
 *
 * What counts as one data action (migration 0040, trigger on action_runs): a
 * run that reached the end system successfully and was started by an agent —
 * incl. runs a team member confirmed and imported MCP tools. Test runs from the
 * settings page, failed calls and rejected runs are not counted.
 */
export const NO_PURCHASE_COST_CATEGORIES: readonly BillingCategory[] = ['data_actions'];

export function hasPurchaseCost(category: BillingCategory): boolean {
  return !NO_PURCHASE_COST_CATEGORIES.includes(category);
}

/** How each position is billed — shown on the price list. */
export const BILLING_CATEGORY_BILLING_LABEL: Record<BillingCategory, string> = {
  ai: 'transaktionell',
  embeddings: 'transaktionell',
  transcription: 'transaktionell',
  voice: 'transaktionell',
  whatsapp: 'transaktionell',
  email: 'transaktionell',
  data_actions: 'transaktionell',
};

/** Sell-price unit per position (what the € amount refers to). */
export const BILLING_CATEGORY_PRICE_UNIT: Record<BillingCategory, string> = {
  ai: '€/Vorgang',
  embeddings: '€/Vorgang',
  transcription: '€/Vorgang',
  voice: '€/Minute',
  whatsapp: '€/Nachricht',
  email: '€/E-Mail',
  data_actions: '€/Aktion',
};

/** Categories with a fixed per-unit purchase cost (rate card). */
export const UNIT_PRICED_CATEGORIES = ['voice', 'whatsapp', 'email'] as const;
export type UnitPricedCategory = (typeof UNIT_PRICED_CATEGORIES)[number];

/** USD cost per unit for the rate-card unit categories. */
const STATIC_UNIT_COST_USD: Record<UnitPricedCategory, number> = {
  voice: VOICE_USD_PER_MINUTE,
  whatsapp: WHATSAPP_USD_PER_MESSAGE,
  email: EMAIL_USD_PER_MESSAGE,
};

// --- price-list rules --------------------------------------------------------

/**
 * A position's sell price: a free EUR unit price — the ONLY rule kind. Rows
 * saved by the short-lived factor-based UI ({mode:'markup'}) are stripped at
 * parse time (per key, via .catch) so display, billing and saving all agree:
 * such a position is unpriced ⇒ pass-through at cost. (Verified 2026-07-23:
 * no markup rows exist in the live DB.)
 */
export const categoryPricingRuleSchema = z.object({
  mode: z.literal('unit'),
  unitPriceEur: z.number().min(0).max(100_000),
});
export type CategoryPricingRule = z.infer<typeof categoryPricingRuleSchema>;

const ruleOptional = categoryPricingRuleSchema.optional().catch(undefined);
/**
 * A usage price list's positions. Absent position ⇒ pass-through at cost.
 * Lists stored before migration 0043 may still carry `numbers_mobile` /
 * `numbers_landline`; those keys are dropped here (the fee per phone number
 * moved into the package) and disappear from the row with its next save.
 */
export const priceTierPricingSchema = z
  .object({
    ai: ruleOptional,
    embeddings: ruleOptional,
    transcription: ruleOptional,
    voice: ruleOptional,
    whatsapp: ruleOptional,
    email: ruleOptional,
    data_actions: ruleOptional,
  })
  .partial();
export type TierPricing = Partial<Record<BillingCategory, CategoryPricingRule>>;

export interface PricingContext {
  /** Fixed internal conversion for displaying USD purchase costs in EUR. */
  usdToEur: number;
  /** Editable monthly purchase cost per number type (EUR). */
  numberCostMobileEur: number;
  numberCostLandlineEur: number;
}

export const DEFAULT_PRICING_CONTEXT: PricingContext = {
  usdToEur: DEFAULT_USD_TO_EUR,
  numberCostMobileEur: DEFAULT_NUMBER_COST_MOBILE_EUR,
  numberCostLandlineEur: DEFAULT_NUMBER_COST_LANDLINE_EUR,
};

/** Our purchase cost per unit in EUR for a unit-priced category. */
export function unitCostEur(category: UnitPricedCategory, ctx: PricingContext): number {
  return STATIC_UNIT_COST_USD[category] * ctx.usdToEur;
}

// --- phone numbers (monthly, part of the package — migration 0043) -------------

/** Phone-number kinds with their own monthly fee (`national` counts as landline). */
export const NUMBER_KINDS = ['mobile', 'landline'] as const;
export type NumberKind = (typeof NUMBER_KINDS)[number];
export const NUMBER_KIND_LABELS: Record<NumberKind, string> = {
  mobile: 'Rufnummer Mobil',
  landline: 'Rufnummer Festnetz',
};

/** What one phone number of this kind costs US per month (EUR, billing_settings). */
export function numberCostEur(kind: NumberKind, ctx: PricingContext): number {
  return kind === 'mobile' ? ctx.numberCostMobileEur : ctx.numberCostLandlineEur;
}

/** Fee per phone number and month. */
export const numberFeeSchema = z.object({
  feeMonthlyEur: z.number().min(0).max(100_000),
});
const numberFeeOptional = numberFeeSchema.optional().catch(undefined);
/**
 * Fee per number kind — the shape of `packages.numbers` (the standard) and of
 * `org_subscriptions.numbers` (a customer's own fee). An absent kind means: in
 * the package "our purchase cost is passed on", at the customer "as in the package".
 */
export const numberFeesSchema = z
  .object({ mobile: numberFeeOptional, landline: numberFeeOptional })
  .partial();
export type NumberFees = Partial<Record<NumberKind, { feeMonthlyEur: number }>>;

/** How many active phone numbers a customer has, per kind. */
export type NumberCounts = Record<NumberKind, number>;

/**
 * Customer price (EUR) for one billing line.
 *   unit rule → quantity × unitPriceEur
 *   no rule   → pass-through at cost (Selbstkostenpreis)
 */
export function categoryPriceEur(
  quantity: number,
  costUsd: number,
  rule: CategoryPricingRule | undefined,
  ctx: PricingContext
): number {
  if (rule) return round2(Math.max(0, quantity) * rule.unitPriceEur);
  return round2(Math.max(0, costUsd) * ctx.usdToEur);
}

// --- packages ----------------------------------------------------------------

/** Channel kinds a package prices/quotas (subset of org_channel_limits; no 'test'). */
export const PACKAGE_CHANNEL_KINDS = ['form', 'email', 'whatsapp', 'voice', 'chat'] as const;
export type PackageChannelKind = (typeof PACKAGE_CHANNEL_KINDS)[number];
export const PACKAGE_CHANNEL_LABELS: Record<PackageChannelKind, string> = {
  form: 'Formular',
  email: 'E-Mail',
  whatsapp: 'WhatsApp',
  voice: 'Telefonie',
  chat: 'Chat-Widget',
};

/** Per channel type: how many are included and the fee per channel. */
export const packageChannelTermSchema = z.object({
  quota: z.number().int().min(0).max(9_999),
  feeMonthlyEur: z.number().min(0).max(1_000_000),
  feeYearlyEur: z.number().min(0).max(1_000_000),
});
export type PackageChannelTerm = z.infer<typeof packageChannelTermSchema>;

const channelTermOptional = packageChannelTermSchema.optional();
export const packageChannelsSchema = z
  .object({
    form: channelTermOptional,
    email: channelTermOptional,
    whatsapp: channelTermOptional,
    voice: channelTermOptional,
    chat: channelTermOptional,
  })
  .partial();
export type PackageChannels = z.infer<typeof packageChannelsSchema>;

export interface PackageFees {
  baseFeeMonthlyEur: number;
  baseFeeYearlyEur: number;
  channels: PackageChannels;
}

/** Total recurring fee: base + Σ (quota × per-channel fee). */
export function packageMonthlyTotalEur(pkg: PackageFees): number {
  let total = pkg.baseFeeMonthlyEur;
  for (const kind of PACKAGE_CHANNEL_KINDS) {
    const term = pkg.channels[kind];
    if (term) total += term.quota * term.feeMonthlyEur;
  }
  return round2(total);
}

export function packageYearlyTotalEur(pkg: PackageFees): number {
  let total = pkg.baseFeeYearlyEur;
  for (const kind of PACKAGE_CHANNEL_KINDS) {
    const term = pkg.channels[kind];
    if (term) total += term.quota * term.feeYearlyEur;
  }
  return round2(total);
}

export type BillingInterval = 'monthly' | 'yearly';

// ============================================================================
// Terms (migration 0042): the package is the standard, a customer only holds
// deviations ("eigene Werte"). Yearly prices follow from the monthly ones.
// ============================================================================
//
// Everything below is pure and has no Node dependency, so the live calculators
// in the admin UI import it in the browser through `@zendori/core/billing`
// (the package index would pull node:crypto into the bundle).

// --- amounts typed by a person ------------------------------------------------

export type EuroInput =
  { ok: true; value: number } | { ok: false; reason: 'empty' | 'invalid' | 'ambiguous' };

/**
 * Reads an amount the way it is written in German: `12`, `12,5`, `1.500,50`.
 * A decimal point is accepted too (`0.05`). `1.500` is refused as ambiguous —
 * it is one thousand five hundred to the person typing and one and a half to a
 * parser, and that difference must never reach an invoice.
 */
export function readEuro(input: string): EuroInput {
  const text = input.replace(/[\s€]/g, '');
  if (text === '') return { ok: false, reason: 'empty' };
  let normalized: string;
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(text) || /^\d+,\d+$/.test(text)) {
    // thousands dots (optional) + decimal comma
    normalized = text.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3}){2,}$/.test(text)) {
    // 1.234.567 — only thousands dots, nothing else it could be
    normalized = text.replace(/\./g, '');
  } else if (/^\d+\.\d+$/.test(text)) {
    const [whole, fraction] = text.split('.') as [string, string];
    // 0.125 is a fraction; 1.500 could be either
    if (fraction.length === 3 && /[1-9]/.test(whole)) return { ok: false, reason: 'ambiguous' };
    normalized = text;
  } else if (/^\d+$/.test(text)) {
    normalized = text;
  } else {
    return { ok: false, reason: 'invalid' };
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: 'invalid' };
}

/** `readEuro` as a number; null for empty, invalid and ambiguous input. */
export function parseEuro(input: string): number | null {
  const result = readEuro(input);
  return result.ok ? result.value : null;
}

/** What to tell the person when an amount could not be read. */
export function euroInputError(reason: 'invalid' | 'ambiguous'): string {
  return reason === 'ambiguous'
    ? 'Nicht eindeutig: Bitte ohne Tausenderpunkt schreiben, zum Beispiel 1500 oder 1,5.'
    : 'Bitte einen Betrag wie 12,50 eingeben.';
}

/** An amount as the value of an input field: decimal comma, no grouping, 2–4 decimals. */
export function formatEuroInput(value: number): string {
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
    useGrouping: false,
  }).format(value);
}

// --- yearly term ---------------------------------------------------------------

/** Share of the monthly price that is charged on a yearly term (1 = no discount). */
export function yearlyFactor(discountPercent: number): number {
  const percent = Number.isFinite(discountPercent) ? discountPercent : 0;
  return 1 - Math.min(100, Math.max(0, percent)) / 100;
}

/** Price of a whole year on a yearly term: 12 × monthly, minus the discount. */
export function yearlyFromMonthlyEur(monthlyEur: number, discountPercent: number): number {
  return round2(12 * Math.max(0, monthlyEur) * yearlyFactor(discountPercent));
}

// --- a customer's own values ---------------------------------------------------

/** A customer's deviation for one channel kind; an absent field = as in the package. */
export const subscriptionChannelOwnSchema = z.object({
  quota: z.number().int().min(0).max(9_999).optional(),
  feeMonthlyEur: z.number().min(0).max(1_000_000).optional(),
});
export type SubscriptionChannelOwn = z.infer<typeof subscriptionChannelOwnSchema>;

const channelOwnOptional = subscriptionChannelOwnSchema.optional().catch(undefined);
export const subscriptionOwnChannelsSchema = z
  .object({
    form: channelOwnOptional,
    email: channelOwnOptional,
    whatsapp: channelOwnOptional,
    voice: channelOwnOptional,
    chat: channelOwnOptional,
  })
  .partial();
export type SubscriptionOwnChannels = Partial<Record<PackageChannelKind, SubscriptionChannelOwn>>;

/** Everything a customer can have that differs from the package. null/absent = standard. */
export interface SubscriptionOwnTerms {
  setupFeeEur: number | null;
  baseFeeMonthlyEur: number | null;
  yearlyDiscountPercent: number | null;
  channels: SubscriptionOwnChannels;
  /** Own fee per phone number and month; wins over the package (0043). */
  numbers: NumberFees;
  /** Own unit price per position; wins over the price list. */
  pricing: TierPricing;
}

export const NO_OWN_TERMS: SubscriptionOwnTerms = {
  setupFeeEur: null,
  baseFeeMonthlyEur: null,
  yearlyDiscountPercent: null,
  channels: {},
  numbers: {},
  pricing: {},
};

/** How many single values of this customer differ from the standard. */
export function countOwnValues(own: SubscriptionOwnTerms): number {
  let count = 0;
  if (own.setupFeeEur !== null) count += 1;
  if (own.baseFeeMonthlyEur !== null) count += 1;
  if (own.yearlyDiscountPercent !== null) count += 1;
  for (const kind of PACKAGE_CHANNEL_KINDS) {
    const term = own.channels[kind];
    if (term?.quota !== undefined) count += 1;
    if (term?.feeMonthlyEur !== undefined) count += 1;
  }
  for (const kind of NUMBER_KINDS) {
    if (own.numbers[kind]) count += 1;
  }
  for (const category of BILLING_CATEGORY_ORDER) {
    if (own.pricing[category]) count += 1;
  }
  return count;
}

// --- a customer's own values, as typed ---------------------------------------------

/** The own values of a customer as text, the way the "Konditionen" form holds them. */
export interface OwnTermsText {
  setupFeeEur: string;
  baseFeeMonthlyEur: string;
  yearlyDiscountPercent: string;
  channels: Partial<Record<PackageChannelKind, { quota: string; feeMonthlyEur: string }>>;
  /** Own fee per phone number and month, per number kind. */
  numbers: Partial<Record<NumberKind, string>>;
  pricing: Partial<Record<BillingCategory, string>>;
}

/**
 * Field of the form: `setup`, `base`, `discount`, `quota:<kind>`, `fee:<kind>`,
 * `number:<kind>`, `price:<category>`.
 */
export type OwnTermsField = string;

export interface OwnTermsRead {
  /** Every value that could be read. An empty field is "as in the package" and absent here. */
  own: SubscriptionOwnTerms;
  /** A message per field that could not be read; empty = everything is fine. */
  errors: Record<OwnTermsField, string>;
}

const MAX_FEE_EUR = 1_000_000;
const MAX_UNIT_PRICE_EUR = 100_000;
export const QUOTA_INPUT_ERROR = 'Ganze Zahl von 0 bis 9999.';
export const DISCOUNT_INPUT_ERROR = 'Bitte eine Zahl von 0 bis 100 eingeben.';
const AMOUNT_TOO_HIGH_ERROR = 'Der Betrag ist zu hoch.';

/** An optional amount: empty = null, otherwise the number or a message. */
function readOptionalAmount(
  text: string,
  max: number
): { value: number | null; error: string | null } {
  const result = readEuro(text);
  if (result.ok) {
    return result.value > max
      ? { value: null, error: AMOUNT_TOO_HIGH_ERROR }
      : { value: result.value, error: null };
  }
  if (result.reason === 'empty') return { value: null, error: null };
  return { value: null, error: euroInputError(result.reason) };
}

/**
 * Reads the own values of a customer from text. The browser (while typing) and
 * the server (when saving) both go through here, so a field can never mean one
 * thing on the screen and another in the database.
 */
export function readOwnTerms(text: OwnTermsText): OwnTermsRead {
  const errors: Record<OwnTermsField, string> = {};
  const amount = (field: OwnTermsField, raw: string, max: number): number | null => {
    const result = readOptionalAmount(raw, max);
    if (result.error) errors[field] = result.error;
    return result.value;
  };

  const setupFeeEur = amount('setup', text.setupFeeEur, MAX_FEE_EUR);
  const baseFeeMonthlyEur = amount('base', text.baseFeeMonthlyEur, MAX_FEE_EUR);

  let yearlyDiscountPercent: number | null = null;
  const discount = readEuro(text.yearlyDiscountPercent);
  if (discount.ok && discount.value <= 100) yearlyDiscountPercent = discount.value;
  else if (discount.ok || discount.reason !== 'empty') errors.discount = DISCOUNT_INPUT_ERROR;

  const channels: SubscriptionOwnChannels = {};
  for (const kind of PACKAGE_CHANNEL_KINDS) {
    const row = text.channels[kind];
    if (!row) continue;
    const term: SubscriptionChannelOwn = {};
    const quotaText = row.quota.trim();
    if (quotaText !== '') {
      if (/^\d{1,4}$/.test(quotaText)) term.quota = Number(quotaText);
      else errors[`quota:${kind}`] = QUOTA_INPUT_ERROR;
    }
    const fee = amount(`fee:${kind}`, row.feeMonthlyEur, MAX_FEE_EUR);
    if (fee !== null) term.feeMonthlyEur = fee;
    if (term.quota !== undefined || term.feeMonthlyEur !== undefined) channels[kind] = term;
  }

  const numbers: NumberFees = {};
  for (const kind of NUMBER_KINDS) {
    const fee = amount(`number:${kind}`, text.numbers[kind] ?? '', MAX_UNIT_PRICE_EUR);
    if (fee !== null) numbers[kind] = { feeMonthlyEur: fee };
  }

  const pricing: TierPricing = {};
  for (const category of BILLING_CATEGORY_ORDER) {
    const price = amount(`price:${category}`, text.pricing[category] ?? '', MAX_UNIT_PRICE_EUR);
    if (price !== null) pricing[category] = { mode: 'unit', unitPriceEur: price };
  }

  return {
    own: { setupFeeEur, baseFeeMonthlyEur, yearlyDiscountPercent, channels, numbers, pricing },
    errors,
  };
}

/**
 * Removes own values that cannot have an effect, so nothing is stored (and
 * counted as "eigener Wert") that never reaches an invoice:
 *   · without a package there are no fixed fees, no channel terms and no fee
 *     per phone number (numbers are then passed on at purchase cost) — only the
 *     own unit prices stay;
 *   · a fee for a channel kind that is not limited (neither by the package nor
 *     by an own number) is never charged.
 */
export function applicableOwnTerms(
  own: SubscriptionOwnTerms,
  pkg: PackageTerms | null
): SubscriptionOwnTerms {
  if (!pkg) return { ...NO_OWN_TERMS, pricing: own.pricing };
  const channels: SubscriptionOwnChannels = {};
  for (const kind of PACKAGE_CHANNEL_KINDS) {
    const term = own.channels[kind];
    if (!term) continue;
    const limited = term.quota !== undefined || pkg.channels[kind] !== undefined;
    const kept: SubscriptionChannelOwn = {};
    if (term.quota !== undefined) kept.quota = term.quota;
    if (term.feeMonthlyEur !== undefined && limited) kept.feeMonthlyEur = term.feeMonthlyEur;
    if (kept.quota !== undefined || kept.feeMonthlyEur !== undefined) channels[kind] = kept;
  }
  return { ...own, channels };
}

/** The own values as text again (for the form fields); absent = empty. */
export function ownTermsToText(own: SubscriptionOwnTerms): OwnTermsText {
  const text = (value: number | null | undefined): string =>
    value === null || value === undefined ? '' : formatEuroInput(value);
  const channels: OwnTermsText['channels'] = {};
  for (const kind of PACKAGE_CHANNEL_KINDS) {
    const term = own.channels[kind];
    channels[kind] = {
      quota: term?.quota === undefined ? '' : String(term.quota),
      feeMonthlyEur: text(term?.feeMonthlyEur),
    };
  }
  const numbers: OwnTermsText['numbers'] = {};
  for (const kind of NUMBER_KINDS) {
    numbers[kind] = text(own.numbers[kind]?.feeMonthlyEur);
  }
  const pricing: OwnTermsText['pricing'] = {};
  for (const category of BILLING_CATEGORY_ORDER) {
    pricing[category] = text(own.pricing[category]?.unitPriceEur);
  }
  return {
    setupFeeEur: text(own.setupFeeEur),
    baseFeeMonthlyEur: text(own.baseFeeMonthlyEur),
    // a percentage reads better without forced decimals: "10", "12,5"
    yearlyDiscountPercent:
      own.yearlyDiscountPercent === null
        ? ''
        : formatEuroInput(own.yearlyDiscountPercent).replace(/,00$/, ''),
    channels,
    numbers,
    pricing,
  };
}

// --- what applies to a customer --------------------------------------------------

/** The fixed part of a package (monthly values; the year follows from the discount). */
export interface PackageTerms {
  setupFeeEur: number;
  baseFeeMonthlyEur: number;
  yearlyDiscountPercent: number;
  channels: Partial<Record<PackageChannelKind, { quota: number; feeMonthlyEur: number }>>;
  /** Fee per phone number and month; an absent kind = our purchase cost is passed on. */
  numbers: NumberFees;
}

export type TermSource = 'package' | 'customer';

export interface EffectiveChannel {
  kind: PackageChannelKind;
  label: string;
  /** How many channels of this kind are included. null = not limited (and no fee). */
  quota: number | null;
  /** Fee per channel and month. */
  feeMonthlyEur: number;
  quotaSource: TermSource;
  feeSource: TermSource;
}

export interface EffectiveNumber {
  kind: NumberKind;
  label: string;
  /** Fee per number and month. null = not priced: our purchase cost is passed on. */
  feeMonthlyEur: number | null;
  feeSource: TermSource;
}

export interface EffectiveTerms {
  setupFeeEur: number;
  setupSource: TermSource;
  baseFeeMonthlyEur: number;
  baseSource: TermSource;
  yearlyDiscountPercent: number;
  discountSource: TermSource;
  /** All five channel kinds, in display order. */
  channels: EffectiveChannel[];
  /** Both number kinds, in display order. */
  numbers: EffectiveNumber[];
}

/**
 * The ONE place that decides what applies to a customer: every own value wins
 * over the package, everything else follows the package. A channel kind the
 * package does not mention is not limited and costs nothing (0017 semantics).
 */
export function resolveTerms(
  pkg: PackageTerms,
  own: SubscriptionOwnTerms = NO_OWN_TERMS
): EffectiveTerms {
  const channels = PACKAGE_CHANNEL_KINDS.map((kind): EffectiveChannel => {
    const standard = pkg.channels[kind];
    const deviation = own.channels[kind];
    return {
      kind,
      label: PACKAGE_CHANNEL_LABELS[kind],
      quota: deviation?.quota ?? standard?.quota ?? null,
      feeMonthlyEur: deviation?.feeMonthlyEur ?? standard?.feeMonthlyEur ?? 0,
      quotaSource: deviation?.quota !== undefined ? 'customer' : 'package',
      feeSource: deviation?.feeMonthlyEur !== undefined ? 'customer' : 'package',
    };
  });
  return {
    setupFeeEur: own.setupFeeEur ?? pkg.setupFeeEur,
    setupSource: own.setupFeeEur !== null ? 'customer' : 'package',
    baseFeeMonthlyEur: own.baseFeeMonthlyEur ?? pkg.baseFeeMonthlyEur,
    baseSource: own.baseFeeMonthlyEur !== null ? 'customer' : 'package',
    yearlyDiscountPercent: own.yearlyDiscountPercent ?? pkg.yearlyDiscountPercent,
    discountSource: own.yearlyDiscountPercent !== null ? 'customer' : 'package',
    channels,
    numbers: NUMBER_KINDS.map((kind): EffectiveNumber => {
      const deviation = own.numbers[kind];
      return {
        kind,
        label: NUMBER_KIND_LABELS[kind],
        feeMonthlyEur: deviation?.feeMonthlyEur ?? pkg.numbers[kind]?.feeMonthlyEur ?? null,
        feeSource: deviation ? 'customer' : 'package',
      };
    }),
  };
}

export interface FeeLine {
  /** Stable id: `base`, `channel:<kind>` or `number:<kind>`. */
  key: string;
  label: string;
  amountEur: number;
}

/**
 * The recurring lines of ONE month. On a yearly term each month carries a
 * twelfth of the yearly price, i.e. the monthly price minus the discount.
 * Lines of 0 € are left out.
 */
export function recurringFeeLines(terms: EffectiveTerms, interval: BillingInterval): FeeLine[] {
  const yearly = interval === 'yearly';
  const factor = yearly ? yearlyFactor(terms.yearlyDiscountPercent) : 1;
  const lines: FeeLine[] = [];
  const base = round2(terms.baseFeeMonthlyEur * factor);
  if (base > 0) {
    lines.push({
      key: 'base',
      label: yearly ? 'Grundgebühr (jährlich, anteilig)' : 'Grundgebühr',
      amountEur: base,
    });
  }
  for (const channel of terms.channels) {
    if (channel.quota === null || channel.quota <= 0) continue;
    const amount = round2(channel.quota * channel.feeMonthlyEur * factor);
    if (amount <= 0) continue;
    lines.push({
      key: `channel:${channel.kind}`,
      label: `${channel.label} (${channel.quota}×)`,
      amountEur: amount,
    });
  }
  return lines;
}

/**
 * The lines for a customer's phone numbers in ONE month: active numbers × fee
 * per number. Only numbers that exist are charged, so a customer without a
 * number pays nothing here. Without a package (`terms` null) and for a kind the
 * package does not price, our purchase cost is passed on — a number is never
 * given away below what it costs us by accident.
 *
 * The yearly discount does not apply: a number is a monthly rental we pay
 * ourselves, and it was not discounted while it stood on the price list.
 */
export function numberFeeLines(
  terms: EffectiveTerms | null,
  counts: NumberCounts,
  ctx: PricingContext
): FeeLine[] {
  const lines: FeeLine[] = [];
  for (const kind of NUMBER_KINDS) {
    const count = Math.max(0, Math.floor(counts[kind] ?? 0));
    if (count === 0) continue;
    const fee = terms?.numbers.find((number) => number.kind === kind)?.feeMonthlyEur ?? null;
    const amount = round2(count * (fee ?? numberCostEur(kind, ctx)));
    if (amount <= 0) continue;
    lines.push({
      key: `number:${kind}`,
      label: `${NUMBER_KIND_LABELS[kind]} (${count}×)`,
      amountEur: amount,
    });
  }
  return lines;
}

/** Sum of the recurring lines of one month. */
export function recurringMonthlyTotalEur(terms: EffectiveTerms, interval: BillingInterval): number {
  return round2(recurringFeeLines(terms, interval).reduce((sum, line) => sum + line.amountEur, 0));
}

/** What a whole year costs on a yearly term (12 × the monthly sum, minus the discount). */
export function termsYearlyTotalEur(terms: EffectiveTerms): number {
  return yearlyFromMonthlyEur(
    recurringMonthlyTotalEur(terms, 'monthly'),
    terms.yearlyDiscountPercent
  );
}

/**
 * The channel limits that go with the terms (org_channel_limits, 0017):
 * a number = at most that many channels, null = no limit row for this kind.
 */
export function channelLimitPlan(
  terms: EffectiveTerms
): { kind: PackageChannelKind; maxCount: number | null }[] {
  return terms.channels.map((channel) => ({ kind: channel.kind, maxCount: channel.quota }));
}

/** A customer's own unit prices on top of the price list that applies to them. */
export function effectivePricing(list: TierPricing | null, own: TierPricing): TierPricing | null {
  const hasOwn = BILLING_CATEGORY_ORDER.some((category) => own[category] !== undefined);
  if (!list && !hasOwn) return null;
  return { ...(list ?? {}), ...own };
}

/**
 * The package's channel terms as stored. The yearly fee per channel is no
 * longer typed in; it is written as 12 × monthly minus the discount, so the
 * stored rows stay complete and readable for older code.
 */
export function packageChannelsForStorage(
  channels: PackageTerms['channels'],
  yearlyDiscountPercent: number
): PackageChannels {
  const stored: PackageChannels = {};
  for (const kind of PACKAGE_CHANNEL_KINDS) {
    const term = channels[kind];
    if (!term) continue;
    stored[kind] = {
      quota: term.quota,
      feeMonthlyEur: term.feeMonthlyEur,
      feeYearlyEur: yearlyFromMonthlyEur(term.feeMonthlyEur, yearlyDiscountPercent),
    };
  }
  return stored;
}

// --- price positions, grouped for the editors -----------------------------------

export const BILLING_CATEGORY_GROUPS: {
  key: 'ai' | 'usage';
  label: string;
  categories: BillingCategory[];
}[] = [
  { key: 'ai', label: 'KI', categories: ['ai', 'embeddings', 'transcription'] },
  {
    key: 'usage',
    label: 'Kanäle und Aktionen',
    categories: ['voice', 'whatsapp', 'email', 'data_actions'],
  },
];

/** "€/Minute" → "je Minute": the unit behind a price, in words. */
export function priceUnitWords(category: BillingCategory): string {
  return BILLING_CATEGORY_PRICE_UNIT[category]
    .replace(/^€\//, 'je ')
    .replace('/Monat', ' und Monat');
}
