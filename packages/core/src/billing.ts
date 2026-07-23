import { z } from 'zod';

// Billing rate card + pricing helpers (single source of truth, CLAUDE.md-style
// "Grundlage fürs Pricing"). All monetary values here are provider LIST PRICES
// in USD and are ASSUMPTIONS to be verified against the signed contracts before
// invoicing a customer (see docs/billing.md). Anthropic/OpenAI token prices are
// not here — those are measured per call and stored in ai_runs.cost_usd
// (packages/ai/src/cost.ts). This module only holds the infra rates that are
// billed by counted quantity (voice minutes, WhatsApp/e-mail messages, number
// rental) plus the FX + markup used to turn our USD cost into a customer €.

/** Cost categories shown in the billing breakdown. */
export type BillingCategory =
  | 'ai' // Anthropic classify/extract/rerank/learn/draft (from ai_runs)
  | 'embeddings' // OpenAI retrieval + KB-index embeddings
  | 'transcription' // OpenAI Whisper (voice notes, from ai_runs)
  | 'voice' // live phone minutes (xAI audio + Twilio SIP)
  | 'whatsapp' // WhatsApp messages (Twilio/Meta)
  | 'email' // outbound e-mail (Resend)
  | 'numbers_mobile' // monthly rental, mobile numbers
  | 'numbers_landline'; // monthly rental, landline numbers (local + national)

/** German labels for the customer/admin UI. */
export const BILLING_CATEGORY_LABELS: Record<BillingCategory, string> = {
  ai: 'KI-Antworten & Klassifikation',
  embeddings: 'Wissensdatenbank-Suche & Indexierung',
  transcription: 'Sprachnachrichten-Transkription',
  voice: 'Telefonie',
  whatsapp: 'WhatsApp-Nachrichten',
  email: 'E-Mail-Versand',
  numbers_mobile: 'Rufnummern (Mobil)',
  numbers_landline: 'Rufnummern (Festnetz)',
};

/** Unit shown next to the quantity per category. */
export const BILLING_CATEGORY_UNIT: Record<BillingCategory, string> = {
  ai: 'Vorgänge',
  embeddings: 'Vorgänge',
  transcription: 'Vorgänge',
  voice: 'Minuten',
  whatsapp: 'Nachrichten',
  email: 'E-Mails',
  numbers_mobile: 'Nummern',
  numbers_landline: 'Nummern',
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

/** Display order of the price-list positions. */
export const BILLING_CATEGORY_ORDER: BillingCategory[] = [
  'ai',
  'embeddings',
  'transcription',
  'voice',
  'whatsapp',
  'email',
  'numbers_mobile',
  'numbers_landline',
];

/** How each position is billed — shown on the price list. */
export const BILLING_CATEGORY_BILLING_LABEL: Record<BillingCategory, string> = {
  ai: 'transaktionell',
  embeddings: 'transaktionell',
  transcription: 'transaktionell',
  voice: 'transaktionell',
  whatsapp: 'transaktionell',
  email: 'transaktionell',
  numbers_mobile: 'monatlich',
  numbers_landline: 'monatlich',
};

/** Sell-price unit per position (what the € amount refers to). */
export const BILLING_CATEGORY_PRICE_UNIT: Record<BillingCategory, string> = {
  ai: '€/Vorgang',
  embeddings: '€/Vorgang',
  transcription: '€/Vorgang',
  voice: '€/Minute',
  whatsapp: '€/Nachricht',
  email: '€/E-Mail',
  numbers_mobile: '€/Nummer/Monat',
  numbers_landline: '€/Nummer/Monat',
};

/** Categories with a fixed per-unit purchase cost (rate card / configured). */
export const UNIT_PRICED_CATEGORIES = [
  'voice',
  'whatsapp',
  'email',
  'numbers_mobile',
  'numbers_landline',
] as const;
export type UnitPricedCategory = (typeof UNIT_PRICED_CATEGORIES)[number];

/** USD cost per unit for the rate-card unit categories (voice/whatsapp/email). */
const STATIC_UNIT_COST_USD: Record<'voice' | 'whatsapp' | 'email', number> = {
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
/** A price list's positions. Absent position ⇒ pass-through at cost. */
export const priceTierPricingSchema = z
  .object({
    ai: ruleOptional,
    embeddings: ruleOptional,
    transcription: ruleOptional,
    voice: ruleOptional,
    whatsapp: ruleOptional,
    email: ruleOptional,
    numbers_mobile: ruleOptional,
    numbers_landline: ruleOptional,
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
  if (category === 'numbers_mobile') return ctx.numberCostMobileEur;
  if (category === 'numbers_landline') return ctx.numberCostLandlineEur;
  return STATIC_UNIT_COST_USD[category] * ctx.usdToEur;
}

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
