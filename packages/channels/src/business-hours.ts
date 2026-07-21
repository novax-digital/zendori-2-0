import { z } from 'zod';

// Pure business-hours + auto-ack helpers (no network, no side effects, fully
// unit-tested). Used by the worker handoff path (Phase 5) to pick an in-/out-of
// hours acknowledgement text, and by the settings UI to parse org_settings jsonb.

// --- schemas -----------------------------------------------------------------

/** Weekday keys, Monday-first, matching org_settings.business_hours slots. */
export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/** HH:MM, 24-hour, 00:00–23:59. */
const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit im Format HH:MM erwartet');

/** One open/close slot for a weekday. */
export const businessDaySchema = z.object({
  open: timeSchema,
  close: timeSchema,
});
export type BusinessDay = z.infer<typeof businessDaySchema>;

/**
 * Business hours per org: an IANA timezone and an optional slot per weekday.
 * A missing or null weekday means "closed" that day.
 */
export const businessHoursSchema = z.object({
  timezone: z.string().min(1).default('Europe/Berlin'),
  hours: z
    .object({
      mon: businessDaySchema.nullish(),
      tue: businessDaySchema.nullish(),
      wed: businessDaySchema.nullish(),
      thu: businessDaySchema.nullish(),
      fri: businessDaySchema.nullish(),
      sat: businessDaySchema.nullish(),
      sun: businessDaySchema.nullish(),
    })
    .default({}),
});
export type BusinessHours = z.infer<typeof businessHoursSchema>;

/** Auto-acknowledgement texts sent to the customer on handoff. */
export const autoAckTextsSchema = z.object({
  enabled: z.boolean().default(false),
  in_hours: z.string().default(''),
  out_of_hours: z.string().default(''),
});
export type AutoAckTexts = z.infer<typeof autoAckTextsSchema>;

// --- helpers -----------------------------------------------------------------

/** Maps the en-US short weekday (as produced by Intl) to our weekday key. */
const SHORT_WEEKDAY_TO_KEY: Record<string, WeekdayKey> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

/** Converts an "HH:MM" string to minutes since midnight, or null if malformed. */
function toMinutes(hhmm: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10) * 60 + Number.parseInt(match[2]!, 10);
}

/** Resolves the weekday key + minutes-of-day for `now` in the given IANA tz. */
function partsInTimezone(now: Date, timezone: string): { key: WeekdayKey; minutes: number } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23', // force 00–23 so midnight is "00", never "24"
    }).formatToParts(now);
  } catch {
    // Invalid timezone → treat as unresolvable (caller falls back to "closed").
    return null;
  }
  let key: WeekdayKey | undefined;
  let hour: number | undefined;
  let minute: number | undefined;
  for (const part of parts) {
    if (part.type === 'weekday') key = SHORT_WEEKDAY_TO_KEY[part.value];
    else if (part.type === 'hour') hour = Number.parseInt(part.value, 10);
    else if (part.type === 'minute') minute = Number.parseInt(part.value, 10);
  }
  if (key === undefined || hour === undefined || minute === undefined) return null;
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return { key, minutes: hour * 60 + minute };
}

/**
 * True when at least one weekday has a usable open/close slot. The settings UI
 * always persists a non-null {timezone, hours} object — even with zero enabled
 * weekdays — so "no slots at all" must be treated as NOT CONFIGURED (not as
 * "always closed"): gating a voice live transfer on always-closed hours would
 * silently disable it for every org that saved keywords before hours (audit
 * finding 2026-07-21). Pure.
 */
export function hasConfiguredHours(hours: BusinessHours | null): boolean {
  if (!hours) return false;
  return WEEKDAY_KEYS.some((key) => {
    const slot = hours.hours[key];
    if (!slot) return false;
    const open = toMinutes(slot.open);
    const close = toMinutes(slot.close);
    return open !== null && close !== null && close > open;
  });
}

/**
 * True when `now` falls inside the open/close slot of its weekday in
 * `hours.timezone`. Missing/null slot for that day, an invalid timezone, or a
 * non-positive slot (close <= open) all count as closed. `open` is inclusive,
 * `close` is exclusive. Pure and side-effect free.
 */
export function isWithinBusinessHours(now: Date, hours: BusinessHours): boolean {
  const resolved = partsInTimezone(now, hours.timezone);
  if (!resolved) return false;
  const slot = hours.hours[resolved.key];
  if (!slot) return false;
  const open = toMinutes(slot.open);
  const close = toMinutes(slot.close);
  if (open === null || close === null || close <= open) return false;
  return resolved.minutes >= open && resolved.minutes < close;
}

/**
 * Picks the auto-ack text to send on handoff:
 * - `null` when acknowledgements are disabled or the chosen text is blank.
 * - inside business hours (and hours are configured) → `in_hours`.
 * - otherwise → `out_of_hours`.
 *
 * When no business hours are configured (`hours === null`) we deliberately fall
 * back to `out_of_hours` as the safe default: without a schedule we cannot claim
 * to be open, so the "we'll get back to you" wording is the honest one.
 */
export function selectAutoAckText(
  now: Date,
  ack: AutoAckTexts,
  hours: BusinessHours | null
): string | null {
  if (!ack.enabled) return null;
  const within = hours ? isWithinBusinessHours(now, hours) : false;
  const text = within ? ack.in_hours : ack.out_of_hours;
  return text.trim().length > 0 ? text : null;
}
