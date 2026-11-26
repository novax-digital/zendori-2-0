import { describe, expect, it } from 'vitest';
import {
  DE_VAT_PERCENT,
  EU_COUNTRIES,
  EU_COUNTRY_LABELS,
  billingDetailsErrorMessage,
  billingDetailsSchema,
  billingDetailsToRow,
  customerTaxExempt,
  decideTax,
  isPeriodKey,
  isVatIdAccepted,
  normalizeVatId,
  parseBillingAccountRow,
  paymentMethodLabel,
  periodKeyOf,
  shiftPeriodKey,
  vatPrefixForCountry,
  type BillingDetails,
  type VatIdCheck,
} from '../src/index.js';

const german = {
  legalName: 'Muster GmbH',
  addressLine1: 'Hauptstraße 1',
  addressLine2: '',
  postalCode: '10115',
  city: 'Berlin',
  country: 'DE',
  vatId: '',
  billingEmail: 'rechnung@example.com',
};

function details(overrides: Record<string, string> = {}): BillingDetails {
  return billingDetailsSchema.parse({ ...german, ...overrides });
}

describe('billing details', () => {
  it('covers all 27 EU member states with a label', () => {
    expect(EU_COUNTRIES).toHaveLength(27);
    expect(new Set(EU_COUNTRIES).size).toBe(27);
    for (const country of EU_COUNTRIES) expect(EU_COUNTRY_LABELS[country]).toBeTruthy();
  });

  it('accepts a German customer without a VAT id', () => {
    expect(billingDetailsSchema.safeParse(german).success).toBe(true);
  });

  it('normalizes the VAT id', () => {
    expect(normalizeVatId(' de 123.456-789 ')).toBe('DE123456789');
    expect(details({ vatId: 'de 123 456 789' }).vatId).toBe('DE123456789');
  });

  it('requires a VAT id outside Germany', () => {
    const result = billingDetailsSchema.safeParse({ ...german, country: 'AT' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(billingDetailsErrorMessage(result.error)).toContain('USt-ID erforderlich');
    }
  });

  it('rejects a VAT id of another country', () => {
    const result = billingDetailsSchema.safeParse({
      ...german,
      country: 'AT',
      vatId: 'DE123456789',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(billingDetailsErrorMessage(result.error)).toContain('passt nicht zum gewählten Land');
    }
  });

  it('rejects a VAT id that is not one', () => {
    const result = billingDetailsSchema.safeParse({ ...german, vatId: '12345' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(billingDetailsErrorMessage(result.error)).toContain('kein gültiges Format');
    }
  });

  it('knows that Greek VAT ids start with EL', () => {
    expect(vatPrefixForCountry('GR')).toBe('EL');
    expect(vatPrefixForCountry('FR')).toBe('FR');
    expect(
      billingDetailsSchema.safeParse({ ...german, country: 'GR', vatId: 'EL123456789' }).success
    ).toBe(true);
    expect(
      billingDetailsSchema.safeParse({ ...german, country: 'GR', vatId: 'GR123456789' }).success
    ).toBe(false);
  });

  it('rejects a country outside the EU', () => {
    for (const country of ['CH', 'GB', 'US', 'XI', '']) {
      expect(billingDetailsSchema.safeParse({ ...german, country }).success).toBe(false);
    }
  });

  it('names the first missing field', () => {
    const result = billingDetailsSchema.safeParse({ ...german, legalName: ' ' });
    expect(result.success).toBe(false);
    if (!result.success) expect(billingDetailsErrorMessage(result.error)).toContain('Firmennamen');
    const mail = billingDetailsSchema.safeParse({ ...german, billingEmail: 'kein-mail' });
    expect(mail.success).toBe(false);
    if (!mail.success) expect(billingDetailsErrorMessage(mail.error)).toContain('Rechnungs-E-Mail');
  });

  it('round-trips through the stored row', () => {
    const value = details({ country: 'AT', vatId: 'ATU12345678', addressLine2: '2. OG' });
    expect(parseBillingAccountRow(billingDetailsToRow(value))).toEqual(value);
    const plain = details();
    const row = billingDetailsToRow(plain);
    expect(row.vat_id).toBeNull();
    expect(row.address_line2).toBeNull();
    expect(parseBillingAccountRow(row)).toEqual(plain);
  });

  it('treats an incomplete or missing row as no details', () => {
    expect(parseBillingAccountRow(null)).toBeNull();
    expect(parseBillingAccountRow({ ...billingDetailsToRow(details()), city: null })).toBeNull();
    // a country that left the list after it was stored
    expect(parseBillingAccountRow({ ...billingDetailsToRow(details()), country: 'CH' })).toBeNull();
  });
});

describe('decideTax', () => {
  const check = (overrides: Partial<VatIdCheck>): VatIdCheck => ({
    value: 'ATU12345678',
    status: null,
    confirmed: false,
    ...overrides,
  });
  const austrian = details({ country: 'AT', vatId: 'ATU12345678' });

  it('holds without details', () => {
    expect(decideTax(null, null)).toEqual({ kind: 'hold', reason: 'missing_details' });
  });

  it('charges 19 % VAT in Germany, whatever the VAT id check says', () => {
    const expected = { kind: 'charge', mode: 'de_vat', percent: DE_VAT_PERCENT, taxExempt: 'none' };
    expect(DE_VAT_PERCENT).toBe(19);
    expect(decideTax(details(), null)).toEqual(expected);
    const withId = details({ vatId: 'DE123456789' });
    for (const status of ['pending', 'unverified', 'unavailable', 'verified', null] as const) {
      expect(decideTax(withId, { value: 'DE123456789', status, confirmed: false })).toEqual(
        expected
      );
    }
  });

  it('uses reverse charge for an EU business with a verified VAT id', () => {
    expect(decideTax(austrian, check({ status: 'verified' }))).toEqual({
      kind: 'charge',
      mode: 'eu_reverse_charge',
      percent: 0,
      taxExempt: 'reverse',
    });
  });

  it('holds an EU customer whose VAT id is not verified', () => {
    for (const status of ['pending', 'unverified', 'unavailable', null] as const) {
      expect(decideTax(austrian, check({ status }))).toEqual({
        kind: 'hold',
        reason: 'vat_id_unverified',
      });
    }
    expect(decideTax(austrian, null)).toEqual({ kind: 'hold', reason: 'vat_id_unverified' });
  });

  it('accepts a VAT id the operator confirmed by hand', () => {
    expect(decideTax(austrian, check({ status: 'unavailable', confirmed: true })).kind).toBe(
      'charge'
    );
  });

  it('ignores a check that belongs to an earlier VAT id', () => {
    const stale = check({ value: 'ATU00000000', status: 'verified', confirmed: true });
    expect(isVatIdAccepted(austrian.vatId, stale)).toBe(false);
    expect(decideTax(austrian, stale)).toEqual({ kind: 'hold', reason: 'vat_id_unverified' });
  });

  it('never accepts an empty VAT id', () => {
    expect(isVatIdAccepted('', { value: '', status: 'verified', confirmed: true })).toBe(false);
  });

  it('keeps the matching tax flag on the Stripe customer', () => {
    expect(customerTaxExempt(details())).toBe('none');
    expect(customerTaxExempt(details({ vatId: 'DE123456789' }))).toBe('none');
    expect(customerTaxExempt(austrian)).toBe('reverse');
  });
});

describe('payment method label', () => {
  it('shows the kind and the last four digits only', () => {
    expect(paymentMethodLabel('sepa_debit', { last4: '3000' })).toBe('SEPA-Lastschrift •••• 3000');
    expect(paymentMethodLabel('card', { brand: 'visa', last4: '4242' })).toBe('Visa •••• 4242');
    expect(paymentMethodLabel('card', { brand: 'something_new', last4: '4242' })).toBe(
      'Karte •••• 4242'
    );
    expect(paymentMethodLabel('card', {})).toBe('Karte');
    // never echo anything that is not exactly four digits
    expect(paymentMethodLabel('sepa_debit', { last4: 'DE89370400440532013000' })).toBe(
      'SEPA-Lastschrift'
    );
  });
});

describe('period keys', () => {
  it('formats and validates YYYY-MM in UTC', () => {
    expect(periodKeyOf(new Date('2026-11-30T23:59:59Z'))).toBe('2026-11');
    expect(periodKeyOf(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12');
    expect(isPeriodKey('2026-11')).toBe(true);
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-11', '', null, 202611]) {
      expect(isPeriodKey(bad)).toBe(false);
    }
  });

  it('shifts across a year boundary', () => {
    expect(shiftPeriodKey('2026-12', 1)).toBe('2027-01');
    expect(shiftPeriodKey('2027-01', -1)).toBe('2026-12');
    expect(shiftPeriodKey('2026-11', 0)).toBe('2026-11');
    expect(shiftPeriodKey('2026-03', -14)).toBe('2025-01');
  });

  it('orders like the calendar when compared as text', () => {
    expect('2026-09' < '2026-10').toBe(true);
    expect('2026-12' < '2027-01').toBe(true);
  });
});
