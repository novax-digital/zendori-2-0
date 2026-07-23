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
  | 'numbers'; // monthly phone-number rental

/** German labels for the customer/admin UI. */
export const BILLING_CATEGORY_LABELS: Record<BillingCategory, string> = {
  ai: 'KI-Antworten & Klassifikation',
  embeddings: 'Wissensdatenbank-Suche & Indexierung',
  transcription: 'Sprachnachrichten-Transkription',
  voice: 'Telefonie',
  whatsapp: 'WhatsApp-Nachrichten',
  email: 'E-Mail-Versand',
  numbers: 'Rufnummern',
};

/** Unit shown next to the quantity per category. */
export const BILLING_CATEGORY_UNIT: Record<BillingCategory, string> = {
  ai: 'Vorgänge',
  embeddings: 'Vorgänge',
  transcription: 'Vorgänge',
  voice: 'Minuten',
  whatsapp: 'Nachrichten',
  email: 'E-Mails',
  numbers: 'Nummern',
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
