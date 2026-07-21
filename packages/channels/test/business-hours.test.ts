import { describe, expect, it } from 'vitest';
import {
  autoAckTextsSchema,
  businessHoursSchema,
  hasConfiguredHours,
  isWithinBusinessHours,
  selectAutoAckText,
  type BusinessHours,
} from '../src/business-hours.js';

// All instants are built in UTC so the tests are deterministic regardless of the
// machine's local timezone. Reference calendar: 2026-01-05 is a Monday, winter
// (Europe/Berlin = UTC+1 / no DST, America/New_York = UTC-5).
const utc = (h: number, m: number, day = 5): Date => new Date(Date.UTC(2026, 0, day, h, m));

const berlinMonNineToFive: BusinessHours = {
  timezone: 'Europe/Berlin',
  hours: { mon: { open: '09:00', close: '17:00' } },
};

describe('businessHoursSchema', () => {
  it('defaults timezone to Europe/Berlin and hours to an empty object', () => {
    const parsed = businessHoursSchema.parse({});
    expect(parsed.timezone).toBe('Europe/Berlin');
    expect(parsed.hours).toEqual({});
  });

  it('parses a full week of slots and keeps null days', () => {
    const parsed = businessHoursSchema.parse({
      timezone: 'Europe/Berlin',
      hours: { mon: { open: '08:30', close: '18:00' }, sun: null },
    });
    expect(parsed.hours.mon).toEqual({ open: '08:30', close: '18:00' });
    expect(parsed.hours.sun).toBeNull();
  });

  it('rejects malformed times', () => {
    expect(() =>
      businessHoursSchema.parse({ hours: { mon: { open: '9:00', close: '17:00' } } })
    ).toThrow();
    expect(() =>
      businessHoursSchema.parse({ hours: { mon: { open: '25:00', close: '26:00' } } })
    ).toThrow();
  });
});

describe('autoAckTextsSchema', () => {
  it('applies safe defaults', () => {
    expect(autoAckTextsSchema.parse({})).toEqual({
      enabled: false,
      in_hours: '',
      out_of_hours: '',
    });
  });

  it('parses configured texts', () => {
    const parsed = autoAckTextsSchema.parse({
      enabled: true,
      in_hours: 'Ein Mitarbeiter übernimmt gleich.',
      out_of_hours: 'Wir melden uns zu den Geschäftszeiten.',
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.in_hours).toBe('Ein Mitarbeiter übernimmt gleich.');
  });
});

describe('hasConfiguredHours', () => {
  it('is false for null and for zero enabled weekdays (settings UI persists {} for "none")', () => {
    // "Always closed" must count as NOT CONFIGURED — gating a voice transfer on
    // it would silently disable live handoff for orgs that saved keywords
    // before hours (0018 audit finding).
    expect(hasConfiguredHours(null)).toBe(false);
    expect(hasConfiguredHours({ timezone: 'Europe/Berlin', hours: {} })).toBe(false);
  });

  it('is false when the only slot is non-positive (close <= open)', () => {
    expect(
      hasConfiguredHours({
        timezone: 'Europe/Berlin',
        hours: { mon: { open: '17:00', close: '08:00' } },
      })
    ).toBe(false);
  });

  it('is true as soon as one weekday has a usable slot', () => {
    expect(
      hasConfiguredHours({
        timezone: 'Europe/Berlin',
        hours: { wed: { open: '08:00', close: '17:00' } },
      })
    ).toBe(true);
  });
});

describe('isWithinBusinessHours', () => {
  it('is true inside the slot for the local weekday', () => {
    // 09:30 UTC → 10:30 Berlin, Monday → inside 09:00–17:00
    expect(isWithinBusinessHours(utc(9, 30), berlinMonNineToFive)).toBe(true);
  });

  it('treats open as inclusive and close as exclusive', () => {
    // 08:00 UTC → 09:00 Berlin exactly → inside
    expect(isWithinBusinessHours(utc(8, 0), berlinMonNineToFive)).toBe(true);
    // 16:00 UTC → 17:00 Berlin exactly → outside (close is exclusive)
    expect(isWithinBusinessHours(utc(16, 0), berlinMonNineToFive)).toBe(false);
  });

  it('is false before opening and after closing', () => {
    // 07:30 UTC → 08:30 Berlin → before open
    expect(isWithinBusinessHours(utc(7, 30), berlinMonNineToFive)).toBe(false);
    // 16:30 UTC → 17:30 Berlin → after close
    expect(isWithinBusinessHours(utc(16, 30), berlinMonNineToFive)).toBe(false);
  });

  it('is false on a closed day (missing or explicit null slot)', () => {
    const withNullTue: BusinessHours = {
      timezone: 'Europe/Berlin',
      hours: { mon: { open: '09:00', close: '17:00' }, tue: null },
    };
    // 2026-01-06 is Tuesday; 10:00 UTC → 11:00 Berlin, explicit null → closed
    expect(isWithinBusinessHours(utc(10, 0, 6), withNullTue)).toBe(false);
    // Sunday is simply absent → closed. 2026-01-04 is Sunday.
    expect(isWithinBusinessHours(utc(10, 0, 4), berlinMonNineToFive)).toBe(false);
  });

  it('resolves the weekday and time in the configured timezone', () => {
    const instant = utc(9, 30); // 09:30 UTC, Monday
    // Berlin: Monday 10:30 → inside
    expect(isWithinBusinessHours(instant, berlinMonNineToFive)).toBe(true);
    // New York (UTC-5): Monday 04:30 → before open → outside
    const nyHours: BusinessHours = {
      timezone: 'America/New_York',
      hours: { mon: { open: '09:00', close: '17:00' } },
    };
    expect(isWithinBusinessHours(instant, nyHours)).toBe(false);
  });

  it('handles the timezone crossing midnight into the next weekday', () => {
    const lateMonday = utc(23, 30); // Monday 23:30 UTC
    // Berlin (UTC+1) → Tuesday 00:30
    const tueSlot: BusinessHours = {
      timezone: 'Europe/Berlin',
      hours: { tue: { open: '00:00', close: '02:00' } },
    };
    expect(isWithinBusinessHours(lateMonday, tueSlot)).toBe(true);
    // Same instant, but only a Monday slot configured → Berlin Tuesday → closed
    expect(isWithinBusinessHours(lateMonday, berlinMonNineToFive)).toBe(false);
  });

  it('is false for an invalid timezone', () => {
    const bad: BusinessHours = {
      timezone: 'Not/AZone',
      hours: { mon: { open: '00:00', close: '23:59' } },
    };
    expect(isWithinBusinessHours(utc(12, 0), bad)).toBe(false);
  });

  it('is false when close is not after open', () => {
    const inverted: BusinessHours = {
      timezone: 'Europe/Berlin',
      hours: { mon: { open: '17:00', close: '09:00' } },
    };
    expect(isWithinBusinessHours(utc(12, 0), inverted)).toBe(false);
  });
});

describe('selectAutoAckText', () => {
  const ack = { enabled: true, in_hours: 'Willkommen', out_of_hours: 'Außerhalb' };

  it('returns null when disabled', () => {
    expect(
      selectAutoAckText(utc(9, 30), { ...ack, enabled: false }, berlinMonNineToFive)
    ).toBeNull();
  });

  it('returns the in-hours text inside business hours', () => {
    // 09:30 UTC → Berlin Monday 10:30 → inside
    expect(selectAutoAckText(utc(9, 30), ack, berlinMonNineToFive)).toBe('Willkommen');
  });

  it('returns the out-of-hours text outside business hours', () => {
    // 19:00 UTC → Berlin Monday 20:00 → outside
    expect(selectAutoAckText(utc(19, 0), ack, berlinMonNineToFive)).toBe('Außerhalb');
  });

  it('falls back to the out-of-hours text when no business hours are configured', () => {
    expect(selectAutoAckText(utc(9, 30), ack, null)).toBe('Außerhalb');
  });

  it('returns null when the selected text is blank', () => {
    expect(
      selectAutoAckText(
        utc(9, 30),
        { enabled: true, in_hours: '   ', out_of_hours: 'x' },
        berlinMonNineToFive
      )
    ).toBeNull();
  });
});
