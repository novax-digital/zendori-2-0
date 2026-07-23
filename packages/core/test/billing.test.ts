import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICING,
  EMAIL_USD_PER_MESSAGE,
  NUMBER_USD_PER_MONTH,
  VOICE_USD_PER_MINUTE,
  WHATSAPP_USD_PER_MESSAGE,
  categoryPriceEur,
  emailCostUsd,
  numberRentalCostUsd,
  packageChannelsSchema,
  packageMonthlyTotalEur,
  packageYearlyTotalEur,
  priceEur,
  priceTierPricingSchema,
  unitCostEur,
  voiceMinutesCostUsd,
  whatsappCostUsd,
  type PricingContext,
} from '../src/billing.js';

const CTX: PricingContext = {
  usdToEur: 1,
  numberCostMobileEur: 4,
  numberCostLandlineEur: 2,
};

describe('billing rate card', () => {
  it('computes voice minute cost linearly', () => {
    expect(voiceMinutesCostUsd(10)).toBeCloseTo(10 * VOICE_USD_PER_MINUTE, 10);
  });

  it('computes WhatsApp and e-mail per message', () => {
    expect(whatsappCostUsd(5)).toBeCloseTo(5 * WHATSAPP_USD_PER_MESSAGE, 10);
    expect(emailCostUsd(1000)).toBeCloseTo(1000 * EMAIL_USD_PER_MESSAGE, 10);
  });

  it('prorates number rental to the period', () => {
    // one number for a full 30-day month = one monthly rate
    expect(numberRentalCostUsd(1, 30)).toBeCloseTo(NUMBER_USD_PER_MONTH, 10);
    // two numbers for 15 days = 2 × rate × 0.5
    expect(numberRentalCostUsd(2, 15)).toBeCloseTo(NUMBER_USD_PER_MONTH, 10);
  });

  it('never returns negative costs for junk input', () => {
    expect(voiceMinutesCostUsd(-5)).toBe(0);
    expect(whatsappCostUsd(-1)).toBe(0);
    expect(numberRentalCostUsd(-1, 30)).toBe(0);
    expect(numberRentalCostUsd(1, -30)).toBe(0);
  });
});

describe('priceEur', () => {
  it('applies FX and markup and rounds to cents', () => {
    // 1 USD × 0.92 × 1.0 (defaults) = 0.92 €
    expect(priceEur(1, DEFAULT_PRICING)).toBe(0.92);
  });

  it('applies a margin markup', () => {
    expect(priceEur(1, { usdToEur: 1, markupFactor: 2.5 })).toBe(2.5);
  });

  it('rounds to whole cents', () => {
    expect(priceEur(0.001, { usdToEur: 1, markupFactor: 1 })).toBe(0);
    expect(priceEur(0.006, { usdToEur: 1, markupFactor: 1 })).toBe(0.01);
  });

  it('clamps negative cost to zero', () => {
    expect(priceEur(-100, DEFAULT_PRICING)).toBe(0);
  });
});

describe('categoryPriceEur (price-list pricing)', () => {
  it('no rule → pass-through at cost (Selbstkostenpreis)', () => {
    // 2 USD cost, fx 1 → 2 € (never a hidden markup, never below cost)
    expect(categoryPriceEur(10, 2, undefined, CTX)).toBe(2);
  });

  it('unit rule ignores cost and multiplies quantity', () => {
    expect(categoryPriceEur(10, 999, { mode: 'unit', unitPriceEur: 0.05 }, CTX)).toBe(0.5);
  });

  it('legacy markup entries are stripped at parse time (⇒ pass-through)', () => {
    // rows from the short-lived factor UI must not survive into pricing
    const parsed = priceTierPricingSchema.parse({
      ai: { mode: 'markup', factor: 3 },
      voice: { mode: 'unit', unitPriceEur: 0.05 },
    });
    expect(parsed.ai).toBeUndefined();
    expect(parsed.voice).toEqual({ mode: 'unit', unitPriceEur: 0.05 });
    // stripped rule ⇒ same as no rule: pass-through at cost
    expect(categoryPriceEur(10, 4, parsed.ai, CTX)).toBe(4);
  });

  it('unit cost card: static categories via fx, numbers from the EUR context', () => {
    expect(unitCostEur('voice', CTX)).toBeCloseTo(VOICE_USD_PER_MINUTE * 1, 10);
    expect(unitCostEur('numbers_mobile', CTX)).toBe(4);
    expect(unitCostEur('numbers_landline', CTX)).toBe(2);
  });
});

describe('package fee totals', () => {
  it('monthly total = base + Σ quota × per-channel fee', () => {
    const pkg = {
      baseFeeMonthlyEur: 49,
      baseFeeYearlyEur: 490,
      channels: {
        whatsapp: { quota: 2, feeMonthlyEur: 20, feeYearlyEur: 200 },
        voice: { quota: 1, feeMonthlyEur: 30, feeYearlyEur: 300 },
      },
    };
    expect(packageMonthlyTotalEur(pkg)).toBe(49 + 2 * 20 + 1 * 30);
    expect(packageYearlyTotalEur(pkg)).toBe(490 + 2 * 200 + 1 * 300);
  });

  it('empty channels → base fee only', () => {
    expect(packageMonthlyTotalEur({ baseFeeMonthlyEur: 10, baseFeeYearlyEur: 100, channels: {} })).toBe(10);
  });
});

describe('pricing/package zod schemas', () => {
  it('accepts a valid pricing map and strips (not rejects) invalid entries', () => {
    expect(
      priceTierPricingSchema.safeParse({ voice: { mode: 'unit', unitPriceEur: 0.05 } }).success
    ).toBe(true);
    // invalid/legacy entries are stripped per key so the rest keeps working
    const mixed = priceTierPricingSchema.parse({
      voice: { mode: 'bogus', x: 1 },
      email: { mode: 'unit', unitPriceEur: 0.01 },
    });
    expect(mixed.voice).toBeUndefined();
    expect(mixed.email).toEqual({ mode: 'unit', unitPriceEur: 0.01 });
  });

  it('accepts a valid channels map and rejects a negative fee', () => {
    expect(
      packageChannelsSchema.safeParse({ whatsapp: { quota: 2, feeMonthlyEur: 20, feeYearlyEur: 200 } }).success
    ).toBe(true);
    expect(
      packageChannelsSchema.safeParse({ whatsapp: { quota: 2, feeMonthlyEur: -1, feeYearlyEur: 0 } }).success
    ).toBe(false);
  });
});
