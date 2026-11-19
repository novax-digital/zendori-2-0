import { describe, expect, it } from 'vitest';
import { areaCodeFromWish, normalizeAreaCode, phoneNumberStatusSchema } from '../src/schemas.js';

// Admin → Telefonnummern (0033): the area code typed by the admin / derived
// from the customer's wish, stored without the trunk zero.

describe('normalizeAreaCode', () => {
  it.each([
    ['0511', '511'],
    ['511', '511'],
    [' 030 ', '30'],
    ['+49 511', '511'],
    ['0049 89', '89'],
  ])('accepts %s', (raw, expected) => {
    expect(normalizeAreaCode(raw)).toBe(expected);
  });

  it('treats empty input as "no restriction"', () => {
    expect(normalizeAreaCode('')).toBeNull();
    expect(normalizeAreaCode(null)).toBeNull();
  });

  it.each(['0', '00', 'Hannover', '0511123456', '5'])('rejects %s', (raw) => {
    expect(normalizeAreaCode(raw)).toBe('invalid');
  });
});

describe('areaCodeFromWish', () => {
  it('extracts a 0-prefixed area code from free text', () => {
    expect(areaCodeFromWish('0511')).toBe('511');
    expect(areaCodeFromWish('Hannover (0511)')).toBe('511');
    expect(areaCodeFromWish('Berlin 030')).toBe('30');
  });

  it('returns null without a recognizable area code', () => {
    expect(areaCodeFromWish('Berlin')).toBeNull();
    expect(areaCodeFromWish(null)).toBeNull();
    expect(areaCodeFromWish('+49 511')).toBeNull();
  });
});

describe('phoneNumberStatusSchema', () => {
  it('knows the 0033 failed state', () => {
    expect(phoneNumberStatusSchema.parse('failed')).toBe('failed');
  });
});
