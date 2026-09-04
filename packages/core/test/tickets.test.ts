import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TICKET_ID_FORMAT,
  TICKET_ORIGINS,
  TICKET_STATUSES,
  formatTicketId,
  isPlaceholderSubject,
  ticketIdFormatSchema,
  validateTicketIdFormat,
} from '../src/tickets.js';

// Ticket id format (0030): rendering must match private.render_ticket_display_id
// token for token — the RLS suite pins SQL vs TS on a live database, these pin
// the TS side alone.

const JULY = new Date('2026-07-15T10:00:00+02:00');

describe('formatTicketId', () => {
  it('renders the default format as a plain number', () => {
    expect(formatTicketId(DEFAULT_TICKET_ID_FORMAT, 42, JULY)).toBe('#42');
  });

  it('zero-pads to the token length and never truncates', () => {
    expect(formatTicketId('ZD-{YYYY}-{NNNN}', 42, JULY)).toBe('ZD-2026-0042');
    expect(formatTicketId('{NN}', 12345, JULY)).toBe('12345');
    expect(formatTicketId('T{N}', 7, JULY)).toBe('T7');
  });

  it('supports the short year and leaves unknown tokens literal', () => {
    expect(formatTicketId('{YY}/{N}', 3, JULY)).toBe('26/3');
    expect(formatTicketId('{X}-{N}', 3, JULY)).toBe('{X}-3');
  });

  it('takes the year in Europe/Berlin (New Year boundary)', () => {
    // 2026-12-31 23:30 UTC is already 2027-01-01 00:30 in Berlin
    expect(formatTicketId('{YYYY}-{N}', 1, new Date('2026-12-31T23:30:00Z'))).toBe('2027-1');
  });
});

describe('validateTicketIdFormat', () => {
  it('accepts the default and the padded/year variants', () => {
    expect(validateTicketIdFormat('#{N}')).toEqual({ ok: true, format: '#{N}' });
    expect(validateTicketIdFormat('  ZD-{YYYY}-{NNNN} ')).toEqual({ ok: true, format: 'ZD-{YYYY}-{NNNN}' });
  });

  it('rejects empty, too long, missing/duplicate number tokens, unknown tokens, stray braces', () => {
    expect(validateTicketIdFormat('').ok).toBe(false);
    expect(validateTicketIdFormat('X'.repeat(41) + '{N}').ok).toBe(false);
    expect(validateTicketIdFormat('TICKET').ok).toBe(false);
    expect(validateTicketIdFormat('{N}-{N}').ok).toBe(false);
    expect(validateTicketIdFormat('{MM}-{N}').ok).toBe(false);
    expect(validateTicketIdFormat('{N}}').ok).toBe(false);
  });

  it('is exposed as a zod schema with the German message', () => {
    const bad = ticketIdFormatSchema.safeParse('nix');
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toContain('Nummern-Platzhalter');
    expect(ticketIdFormatSchema.parse(' #{N} ')).toBe('#{N}');
  });
});

describe('enums and helpers', () => {
  it('pins the status/origin sets the migration CHECKs enforce', () => {
    expect(TICKET_STATUSES).toEqual(['open', 'in_progress', 'waiting', 'resolved']);
    expect(TICKET_ORIGINS).toHaveLength(10);
  });

  it('treats ingest placeholders as empty subjects', () => {
    expect(isPlaceholderSubject(null)).toBe(true);
    expect(isPlaceholderSubject('  ')).toBe(true);
    expect(isPlaceholderSubject('Anruf von +49301234')).toBe(true);
    expect(isPlaceholderSubject('Eingehender Anruf')).toBe(true);
    expect(isPlaceholderSubject('Rechnungsfrage')).toBe(false);
  });
});
