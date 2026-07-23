import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICING,
  EMAIL_USD_PER_MESSAGE,
  NUMBER_USD_PER_MONTH,
  VOICE_USD_PER_MINUTE,
  WHATSAPP_USD_PER_MESSAGE,
  emailCostUsd,
  numberRentalCostUsd,
  priceEur,
  voiceMinutesCostUsd,
  whatsappCostUsd,
} from '../src/billing.js';

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
