import { describe, expect, it } from 'vitest';
import {
  BILLING_CATEGORY_GROUPS,
  BILLING_CATEGORY_ORDER,
  NO_OWN_TERMS,
  PACKAGE_CHANNEL_KINDS,
  applicableOwnTerms,
  channelLimitPlan,
  countOwnValues,
  effectivePricing,
  euroInputError,
  formatEuroInput,
  ownTermsToText,
  packageChannelsForStorage,
  packageChannelsSchema,
  parseEuro,
  priceUnitWords,
  readEuro,
  readOwnTerms,
  recurringFeeLines,
  recurringMonthlyTotalEur,
  resolveTerms,
  subscriptionOwnChannelsSchema,
  termsYearlyTotalEur,
  yearlyFactor,
  yearlyFromMonthlyEur,
  type OwnTermsText,
  type PackageTerms,
  type SubscriptionOwnTerms,
} from '../src/billing.js';

// Terms (migration 0042): the package is the standard, a customer only holds
// deviations, and the yearly price follows from the monthly one. These tests pin
// the money rules — a wrong one would end up on an automatically sent invoice.

/** The package as it exists in production: only WhatsApp costs something. */
const STARTER: PackageTerms = {
  setupFeeEur: 0,
  baseFeeMonthlyEur: 0,
  yearlyDiscountPercent: 0,
  channels: {
    form: { quota: 1, feeMonthlyEur: 0 },
    email: { quota: 1, feeMonthlyEur: 0 },
    whatsapp: { quota: 1, feeMonthlyEur: 15 },
    voice: { quota: 1, feeMonthlyEur: 0 },
    chat: { quota: 1, feeMonthlyEur: 0 },
  },
};

const own = (overrides: Partial<SubscriptionOwnTerms>): SubscriptionOwnTerms => ({
  ...NO_OWN_TERMS,
  ...overrides,
});

describe('readEuro', () => {
  it('reads German and plain notation', () => {
    const cases: [string, number][] = [
      ['12', 12],
      ['12,5', 12.5],
      ['12,50', 12.5],
      ['0,05', 0.05],
      ['0.05', 0.05],
      ['0,0184', 0.0184],
      ['0.005', 0.005],
      ['1.5', 1.5],
      ['1500', 1500],
      ['1500,50', 1500.5],
      ['1.500,50', 1500.5],
      ['1.234.567', 1234567],
      ['1.234.567,89', 1234567.89],
      [' 15,00 € ', 15],
      ['0', 0],
    ];
    for (const [input, expected] of cases) {
      expect(readEuro(input), input).toEqual({ ok: true, value: expected });
      expect(parseEuro(input), input).toBe(expected);
    }
  });

  it('refuses 1.500: fifteen hundred to the person, one and a half to a parser', () => {
    for (const input of ['1.500', '12.345', '999.000']) {
      expect(readEuro(input), input).toEqual({ ok: false, reason: 'ambiguous' });
      expect(parseEuro(input), input).toBeNull();
    }
    expect(euroInputError('ambiguous')).toContain('Tausenderpunkt');
  });

  it('refuses everything that is not an amount', () => {
    for (const input of [
      'abc',
      '-1',
      '1,2,3',
      '1..5',
      '1,',
      ',5',
      '1.50.2',
      '1e3',
      '12 €x',
      '+5',
    ]) {
      expect(readEuro(input), input).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(euroInputError('invalid')).toContain('12,50');
  });

  it('tells empty apart from wrong', () => {
    expect(readEuro('')).toEqual({ ok: false, reason: 'empty' });
    expect(readEuro('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseEuro('')).toBeNull();
  });

  it('round-trips what the form shows', () => {
    for (const value of [0, 15, 0.05, 0.0184, 1500.5, 0.005, 162]) {
      expect(parseEuro(formatEuroInput(value)), String(value)).toBe(value);
    }
    expect(formatEuroInput(15)).toBe('15,00');
    expect(formatEuroInput(0.0184)).toBe('0,0184');
    // no thousands dot in an input — it would be refused on the way back
    expect(formatEuroInput(1500.5)).toBe('1500,50');
  });
});

describe('yearly term', () => {
  it('is 12 × monthly minus the discount', () => {
    expect(yearlyFromMonthlyEur(15, 0)).toBe(180);
    expect(yearlyFromMonthlyEur(15, 10)).toBe(162);
    expect(yearlyFromMonthlyEur(99.99, 15)).toBe(1019.9);
    expect(yearlyFromMonthlyEur(0, 50)).toBe(0);
  });

  it('keeps the discount between 0 and 100 %', () => {
    expect(yearlyFactor(0)).toBe(1);
    expect(yearlyFactor(100)).toBe(0);
    expect(yearlyFactor(-5)).toBe(1);
    expect(yearlyFactor(250)).toBe(0);
    expect(yearlyFactor(Number.NaN)).toBe(1);
  });
});

describe('resolveTerms', () => {
  it('follows the package when the customer has no own values', () => {
    const terms = resolveTerms(STARTER);
    expect(terms.setupSource).toBe('package');
    expect(terms.baseSource).toBe('package');
    expect(terms.discountSource).toBe('package');
    expect(terms.channels.map((c) => c.kind)).toEqual([...PACKAGE_CHANNEL_KINDS]);
    expect(
      terms.channels.every((c) => c.quotaSource === 'package' && c.feeSource === 'package')
    ).toBe(true);
    expect(terms.channels.find((c) => c.kind === 'whatsapp')).toMatchObject({
      quota: 1,
      feeMonthlyEur: 15,
      label: 'WhatsApp',
    });
  });

  it('lets every own value win, field by field', () => {
    const terms = resolveTerms(
      STARTER,
      own({
        setupFeeEur: 250,
        baseFeeMonthlyEur: 49,
        yearlyDiscountPercent: 20,
        channels: { whatsapp: { quota: 2 }, chat: { feeMonthlyEur: 5 } },
      })
    );
    expect(terms).toMatchObject({
      setupFeeEur: 250,
      setupSource: 'customer',
      baseFeeMonthlyEur: 49,
      baseSource: 'customer',
      yearlyDiscountPercent: 20,
      discountSource: 'customer',
    });
    // own quota, fee still from the package
    expect(terms.channels.find((c) => c.kind === 'whatsapp')).toMatchObject({
      quota: 2,
      feeMonthlyEur: 15,
      quotaSource: 'customer',
      feeSource: 'package',
    });
    // own fee, quota still from the package
    expect(terms.channels.find((c) => c.kind === 'chat')).toMatchObject({
      quota: 1,
      feeMonthlyEur: 5,
      quotaSource: 'package',
      feeSource: 'customer',
    });
  });

  it('treats 0 as a value, not as "nothing entered"', () => {
    const paid: PackageTerms = { ...STARTER, setupFeeEur: 500, baseFeeMonthlyEur: 99 };
    const terms = resolveTerms(
      paid,
      own({ setupFeeEur: 0, baseFeeMonthlyEur: 0, channels: { whatsapp: { quota: 0 } } })
    );
    expect(terms.setupFeeEur).toBe(0);
    expect(terms.baseFeeMonthlyEur).toBe(0);
    expect(terms.channels.find((c) => c.kind === 'whatsapp')?.quota).toBe(0);
  });

  it('keeps a channel kind the package does not mention unlimited and free', () => {
    const terms = resolveTerms({
      ...STARTER,
      channels: { whatsapp: { quota: 1, feeMonthlyEur: 15 } },
    });
    const voice = terms.channels.find((c) => c.kind === 'voice')!;
    expect(voice.quota).toBeNull();
    expect(voice.feeMonthlyEur).toBe(0);
  });

  it('counts own values one by one', () => {
    expect(countOwnValues(NO_OWN_TERMS)).toBe(0);
    expect(
      countOwnValues(
        own({
          setupFeeEur: 0,
          channels: { whatsapp: { quota: 2, feeMonthlyEur: 12 }, chat: { quota: 3 } },
          pricing: { voice: { mode: 'unit', unitPriceEur: 0.3 } },
        })
      )
    ).toBe(5);
  });
});

describe('recurringFeeLines', () => {
  it('bills the production package exactly as before: WhatsApp (1×) 15,00 € per month', () => {
    const terms = resolveTerms(STARTER);
    expect(recurringFeeLines(terms, 'monthly')).toEqual([
      { key: 'channel:whatsapp', label: 'WhatsApp (1×)', amountEur: 15 },
    ]);
    expect(recurringMonthlyTotalEur(terms, 'monthly')).toBe(15);
  });

  it('charges the monthly price minus the discount on a yearly term — never 0 by accident', () => {
    const noDiscount = resolveTerms(STARTER);
    expect(recurringFeeLines(noDiscount, 'yearly')).toEqual([
      { key: 'channel:whatsapp', label: 'WhatsApp (1×)', amountEur: 15 },
    ]);
    const discounted = resolveTerms({
      ...STARTER,
      baseFeeMonthlyEur: 100,
      yearlyDiscountPercent: 10,
    });
    expect(recurringFeeLines(discounted, 'yearly')).toEqual([
      { key: 'base', label: 'Grundgebühr (jährlich, anteilig)', amountEur: 90 },
      { key: 'channel:whatsapp', label: 'WhatsApp (1×)', amountEur: 13.5 },
    ]);
    expect(recurringMonthlyTotalEur(discounted, 'yearly')).toBe(103.5);
    // the same year, said two ways
    expect(termsYearlyTotalEur(discounted)).toBe(1242);
    expect(12 * recurringMonthlyTotalEur(discounted, 'yearly')).toBe(1242);
  });

  it('multiplies the fee by the number of channels', () => {
    const terms = resolveTerms(STARTER, own({ channels: { whatsapp: { quota: 3 } } }));
    expect(recurringFeeLines(terms, 'monthly')).toEqual([
      { key: 'channel:whatsapp', label: 'WhatsApp (3×)', amountEur: 45 },
    ]);
  });

  it('leaves out blocked, unlimited and free channels', () => {
    const blocked = resolveTerms(STARTER, own({ channels: { whatsapp: { quota: 0 } } }));
    expect(recurringFeeLines(blocked, 'monthly')).toEqual([]);
    const unlimited = resolveTerms(
      { ...STARTER, channels: {} },
      own({ channels: { voice: { feeMonthlyEur: 30 } } })
    );
    // a fee without a number of channels has nothing to multiply with
    expect(recurringFeeLines(unlimited, 'monthly')).toEqual([]);
  });

  it('puts the base fee first', () => {
    const terms = resolveTerms({ ...STARTER, baseFeeMonthlyEur: 99 });
    expect(recurringFeeLines(terms, 'monthly').map((line) => line.key)).toEqual([
      'base',
      'channel:whatsapp',
    ]);
    expect(recurringFeeLines(terms, 'monthly')[0]).toEqual({
      key: 'base',
      label: 'Grundgebühr',
      amountEur: 99,
    });
  });
});

describe('channelLimitPlan', () => {
  it('turns the terms into limits: a number, or no limit at all', () => {
    const terms = resolveTerms(
      {
        ...STARTER,
        channels: {
          whatsapp: { quota: 1, feeMonthlyEur: 15 },
          chat: { quota: 0, feeMonthlyEur: 0 },
        },
      },
      own({ channels: { whatsapp: { quota: 2 } } })
    );
    expect(channelLimitPlan(terms)).toEqual([
      { kind: 'form', maxCount: null },
      { kind: 'email', maxCount: null },
      { kind: 'whatsapp', maxCount: 2 },
      { kind: 'voice', maxCount: null },
      { kind: 'chat', maxCount: 0 },
    ]);
  });
});

describe('effectivePricing', () => {
  const list = {
    voice: { mode: 'unit' as const, unitPriceEur: 0.45 },
    email: { mode: 'unit' as const, unitPriceEur: 0.01 },
  };

  it('puts own unit prices on top of the list', () => {
    expect(effectivePricing(list, { voice: { mode: 'unit', unitPriceEur: 0.3 } })).toEqual({
      voice: { mode: 'unit', unitPriceEur: 0.3 },
      email: { mode: 'unit', unitPriceEur: 0.01 },
    });
  });

  it('returns the list unchanged without own prices, and null without both', () => {
    expect(effectivePricing(list, {})).toEqual(list);
    expect(effectivePricing(null, {})).toBeNull();
    expect(effectivePricing(null, { voice: { mode: 'unit', unitPriceEur: 0.3 } })).toEqual({
      voice: { mode: 'unit', unitPriceEur: 0.3 },
    });
  });
});

describe('stored shapes', () => {
  it('writes the yearly channel fee from the monthly one, readable for older code', () => {
    const stored = packageChannelsForStorage(STARTER.channels, 10);
    expect(stored.whatsapp).toEqual({ quota: 1, feeMonthlyEur: 15, feeYearlyEur: 162 });
    expect(stored.chat).toEqual({ quota: 1, feeMonthlyEur: 0, feeYearlyEur: 0 });
    expect(packageChannelsSchema.safeParse(stored).success).toBe(true);
    // a kind without a term stays absent (= unlimited)
    expect(packageChannelsForStorage({ voice: { quota: 2, feeMonthlyEur: 30 } }, 0)).toEqual({
      voice: { quota: 2, feeMonthlyEur: 30, feeYearlyEur: 360 },
    });
  });

  it('parses own channel values and drops what is broken, per kind', () => {
    const parsed = subscriptionOwnChannelsSchema.parse({
      whatsapp: { quota: 2 },
      chat: { feeMonthlyEur: 5 },
      voice: { quota: -1 },
      email: 'nonsense',
    });
    expect(parsed.whatsapp).toEqual({ quota: 2 });
    expect(parsed.chat).toEqual({ feeMonthlyEur: 5 });
    expect(parsed.voice).toBeUndefined();
    expect(parsed.email).toBeUndefined();
    expect(subscriptionOwnChannelsSchema.parse({})).toEqual({});
  });
});

describe('price positions for the editors', () => {
  it('groups every position exactly once', () => {
    const grouped = BILLING_CATEGORY_GROUPS.flatMap((group) => group.categories);
    expect([...grouped].sort()).toEqual([...BILLING_CATEGORY_ORDER].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('says the unit in words', () => {
    expect(priceUnitWords('voice')).toBe('je Minute');
    expect(priceUnitWords('ai')).toBe('je Vorgang');
    expect(priceUnitWords('numbers_mobile')).toBe('je Nummer und Monat');
    expect(priceUnitWords('data_actions')).toBe('je Aktion');
  });
});

describe("a customer's own values, as typed (Konditionen)", () => {
  const EMPTY: OwnTermsText = {
    setupFeeEur: '',
    baseFeeMonthlyEur: '',
    yearlyDiscountPercent: '',
    channels: {},
    pricing: {},
  };

  it('reads an empty form as "exactly the package"', () => {
    const read = readOwnTerms(EMPTY);
    expect(read.errors).toEqual({});
    expect(read.own).toEqual(NO_OWN_TERMS);
    expect(countOwnValues(read.own)).toBe(0);
  });

  it('keeps 0 as an own value — it is not the same as empty', () => {
    const read = readOwnTerms({
      ...EMPTY,
      setupFeeEur: '0',
      baseFeeMonthlyEur: '0,00',
      yearlyDiscountPercent: '0',
      channels: { whatsapp: { quota: '0', feeMonthlyEur: '0' } },
      pricing: { voice: '0' },
    });
    expect(read.errors).toEqual({});
    expect(read.own.setupFeeEur).toBe(0);
    expect(read.own.baseFeeMonthlyEur).toBe(0);
    expect(read.own.yearlyDiscountPercent).toBe(0);
    expect(read.own.channels.whatsapp).toEqual({ quota: 0, feeMonthlyEur: 0 });
    expect(read.own.pricing.voice).toEqual({ mode: 'unit', unitPriceEur: 0 });
    expect(countOwnValues(read.own)).toBe(6);
  });

  it('reads German amounts and only the fields that were filled in', () => {
    const read = readOwnTerms({
      ...EMPTY,
      baseFeeMonthlyEur: '1.500,50',
      channels: {
        whatsapp: { quota: '2', feeMonthlyEur: '' },
        chat: { quota: '', feeMonthlyEur: '4,5' },
        email: { quota: '', feeMonthlyEur: '' },
      },
      pricing: { voice: '0,39', ai: '' },
    });
    expect(read.errors).toEqual({});
    expect(read.own.baseFeeMonthlyEur).toBe(1500.5);
    expect(read.own.channels).toEqual({ whatsapp: { quota: 2 }, chat: { feeMonthlyEur: 4.5 } });
    expect(read.own.pricing).toEqual({ voice: { mode: 'unit', unitPriceEur: 0.39 } });
  });

  it('names every field it could not read and leaves that value out', () => {
    const read = readOwnTerms({
      ...EMPTY,
      setupFeeEur: '1.500',
      baseFeeMonthlyEur: 'abc',
      yearlyDiscountPercent: '120',
      channels: {
        whatsapp: { quota: '1,5', feeMonthlyEur: '2000000' },
        voice: { quota: '10000', feeMonthlyEur: '' },
      },
      pricing: { email: '-1', voice: '100001' },
    });
    expect(Object.keys(read.errors).sort()).toEqual(
      [
        'base',
        'discount',
        'fee:whatsapp',
        'price:email',
        'price:voice',
        'quota:voice',
        'quota:whatsapp',
        'setup',
      ].sort()
    );
    expect(read.errors.setup).toBe(euroInputError('ambiguous'));
    expect(read.own).toEqual(NO_OWN_TERMS);
  });

  it('accepts a discount with decimals up to exactly 100', () => {
    expect(
      readOwnTerms({ ...EMPTY, yearlyDiscountPercent: '12,5' }).own.yearlyDiscountPercent
    ).toBe(12.5);
    expect(readOwnTerms({ ...EMPTY, yearlyDiscountPercent: '100' }).errors).toEqual({});
    expect(
      readOwnTerms({ ...EMPTY, yearlyDiscountPercent: '100,01' }).errors.discount
    ).toBeDefined();
  });

  it('survives the round trip through the form fields', () => {
    const own: SubscriptionOwnTerms = {
      setupFeeEur: 0,
      baseFeeMonthlyEur: 49,
      yearlyDiscountPercent: 12.5,
      channels: { whatsapp: { quota: 2 }, chat: { feeMonthlyEur: 4.5 }, voice: { quota: 0 } },
      pricing: {
        voice: { mode: 'unit', unitPriceEur: 0.39 },
        ai: { mode: 'unit', unitPriceEur: 0.0125 },
      },
    };
    const text = ownTermsToText(own);
    expect(text.baseFeeMonthlyEur).toBe('49,00');
    expect(text.yearlyDiscountPercent).toBe('12,50');
    expect(text.channels.whatsapp).toEqual({ quota: '2', feeMonthlyEur: '' });
    expect(text.channels.email).toEqual({ quota: '', feeMonthlyEur: '' });
    expect(text.pricing.ai).toBe('0,0125');
    const read = readOwnTerms(text);
    expect(read.errors).toEqual({});
    expect(read.own).toEqual(own);
    // a whole percentage is shown without decimals
    expect(
      ownTermsToText({ ...NO_OWN_TERMS, yearlyDiscountPercent: 10 }).yearlyDiscountPercent
    ).toBe('10');
  });

  it('drops fixed own values when there is no package, keeps the own unit prices', () => {
    const own: SubscriptionOwnTerms = {
      setupFeeEur: 99,
      baseFeeMonthlyEur: 49,
      yearlyDiscountPercent: 10,
      channels: { whatsapp: { quota: 2, feeMonthlyEur: 10 } },
      pricing: { voice: { mode: 'unit', unitPriceEur: 0.39 } },
    };
    expect(applicableOwnTerms(own, null)).toEqual({
      ...NO_OWN_TERMS,
      pricing: { voice: { mode: 'unit', unitPriceEur: 0.39 } },
    });
  });

  it('drops a fee for a channel kind that is not limited at all', () => {
    // a package that does not mention telephony: not limited, never charged
    const { voice: _voice, ...withoutVoice } = STARTER.channels;
    const pkg: PackageTerms = { ...STARTER, channels: withoutVoice };
    const kept = applicableOwnTerms(
      {
        ...NO_OWN_TERMS,
        channels: {
          voice: { feeMonthlyEur: 20 },
          whatsapp: { feeMonthlyEur: 10 },
          chat: { quota: 3 },
        },
      },
      pkg
    );
    expect(kept.channels).toEqual({ whatsapp: { feeMonthlyEur: 10 }, chat: { quota: 3 } });
    // with an own number the kind is limited, so its fee applies and stays
    const limited = applicableOwnTerms(
      { ...NO_OWN_TERMS, channels: { voice: { quota: 1, feeMonthlyEur: 20 } } },
      pkg
    );
    expect(limited.channels.voice).toEqual({ quota: 1, feeMonthlyEur: 20 });
    expect(recurringMonthlyTotalEur(resolveTerms(pkg, limited), 'monthly')).toBe(35);
  });

  it('what was typed is what is charged: one more WhatsApp channel doubles the fee', () => {
    const read = readOwnTerms({
      ...EMPTY,
      channels: { whatsapp: { quota: '2', feeMonthlyEur: '' } },
    });
    const terms = resolveTerms(STARTER, applicableOwnTerms(read.own, STARTER));
    expect(recurringMonthlyTotalEur(terms, 'monthly')).toBe(30);
    expect(channelLimitPlan(terms).find((limit) => limit.kind === 'whatsapp')?.maxCount).toBe(2);
  });
});
