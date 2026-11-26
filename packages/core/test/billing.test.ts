import { describe, expect, it } from 'vitest';
import {
  BILLING_CATEGORY_BILLING_LABEL,
  BILLING_CATEGORY_LABELS,
  BILLING_CATEGORY_ORDER,
  BILLING_CATEGORY_PRICE_UNIT,
  BILLING_CATEGORY_UNIT,
  DEFAULT_PRICING,
  EMAIL_USD_PER_MESSAGE,
  NUMBER_USD_PER_MONTH,
  VOICE_USD_PER_MINUTE,
  WHATSAPP_USD_PER_MESSAGE,
  categoryPriceEur,
  emailCostUsd,
  hasPurchaseCost,
  numberCostEur,
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
    expect(numberCostEur('mobile', CTX)).toBe(4);
    expect(numberCostEur('landline', CTX)).toBe(2);
  });

  it('a usage price list holds no monthly position: old number keys are dropped', () => {
    // rows saved before 0043 still carry the keys; the fee per number is in the package now
    const parsed = priceTierPricingSchema.parse({
      voice: { mode: 'unit', unitPriceEur: 0.5 },
      numbers_mobile: { mode: 'unit', unitPriceEur: 30 },
      numbers_landline: { mode: 'unit', unitPriceEur: 10 },
    });
    expect(parsed).toEqual({ voice: { mode: 'unit', unitPriceEur: 0.5 } });
    expect(BILLING_CATEGORY_ORDER).not.toContain('numbers_mobile');
    expect(BILLING_CATEGORY_ORDER).toHaveLength(7);
    for (const category of BILLING_CATEGORY_ORDER) {
      expect(BILLING_CATEGORY_BILLING_LABEL[category]).toBe('transaktionell');
    }
  });
});

describe('data actions (billing position without a purchase cost)', () => {
  it('is a price-list position with label, unit and billing kind', () => {
    expect(BILLING_CATEGORY_ORDER).toContain('data_actions');
    expect(BILLING_CATEGORY_LABELS.data_actions).toBe('Data Actions');
    expect(BILLING_CATEGORY_UNIT.data_actions).toBe('Aktionen');
    expect(BILLING_CATEGORY_PRICE_UNIT.data_actions).toBe('€/Aktion');
    expect(BILLING_CATEGORY_BILLING_LABEL.data_actions).toBe('transaktionell');
    // every position has every piece of metadata
    for (const category of BILLING_CATEGORY_ORDER) {
      expect(BILLING_CATEGORY_LABELS[category]).toBeTruthy();
      expect(BILLING_CATEGORY_PRICE_UNIT[category]).toMatch(/^€\//);
    }
  });

  it('has no purchase cost — every other position has one', () => {
    expect(hasPurchaseCost('data_actions')).toBe(false);
    for (const category of BILLING_CATEGORY_ORDER.filter((c) => c !== 'data_actions')) {
      expect(hasPurchaseCost(category)).toBe(true);
    }
  });

  it('with a price: quantity × price per action, rounded to cents', () => {
    const rule = { mode: 'unit' as const, unitPriceEur: 0.15 };
    expect(categoryPriceEur(0, 0, rule, CTX)).toBe(0);
    expect(categoryPriceEur(1, 0, rule, CTX)).toBe(0.15);
    expect(categoryPriceEur(37, 0, rule, CTX)).toBe(5.55);
    expect(categoryPriceEur(1000, 0, { mode: 'unit', unitPriceEur: 0.0125 }, CTX)).toBe(12.5);
  });

  it('without a price it is not charged (pass-through at cost = 0 €)', () => {
    expect(categoryPriceEur(500, 0, undefined, CTX)).toBe(0);
  });

  it('the price list schema keeps the position', () => {
    const parsed = priceTierPricingSchema.parse({
      data_actions: { mode: 'unit', unitPriceEur: 0.2 },
      voice: { mode: 'unit', unitPriceEur: 0.5 },
    });
    expect(parsed.data_actions).toEqual({ mode: 'unit', unitPriceEur: 0.2 });
    // a negative price is stripped like for every other position (⇒ not charged)
    expect(
      priceTierPricingSchema.parse({ data_actions: { mode: 'unit', unitPriceEur: -1 } })
        .data_actions
    ).toBeUndefined();
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
