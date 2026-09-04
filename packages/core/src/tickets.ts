import { z } from 'zod';
import { conversationPrioritySchema, type ConversationPriority } from './schemas.js';

// Re-exported so client code importing this subpath never needs the barrel.
export type { ConversationPriority };

// Tickets (Phase 11, migration 0030): a ticket is a WORK ITEM created from a
// conversation — the conversation keeps flowing in the inbox, the ticket owns
// status/priority/assignee/HubSpot state. This module is pure (zod only) and
// exported as the client-safe subpath `@zendori/core/tickets` so the settings
// preview can import it without dragging the core barrel (node:crypto) into
// the browser bundle.

export const TICKET_STATUSES = ['open', 'in_progress', 'waiting', 'resolved'] as const;
export const ticketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

/** How a ticket came to be — see docs/phase-11-tickets.md for the trigger table. */
export const TICKET_ORIGINS = [
  'handoff',
  'intake',
  'suppressed',
  'no_agent',
  'draft_only',
  'pipeline_failure',
  'voice',
  'form',
  'manual',
  'takeover',
] as const;
export const ticketOriginSchema = z.enum(TICKET_ORIGINS);
export type TicketOrigin = z.infer<typeof ticketOriginSchema>;

export const TICKET_EVENT_KINDS = [
  'created',
  'attached',
  'status_changed',
  'assigned',
  'hubspot_synced',
  'note',
] as const;
export const ticketEventKindSchema = z.enum(TICKET_EVENT_KINDS);
export type TicketEventKind = z.infer<typeof ticketEventKindSchema>;

export const ticketSchema = z.object({
  id: z.uuid(),
  org_id: z.uuid(),
  conversation_id: z.uuid(),
  channel_id: z.uuid(),
  contact_id: z.uuid().nullable(),
  number: z.number().int(),
  /** Rendered once at creation from org_settings.ticket_id_format — frozen. */
  display_id: z.string(),
  subject: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  status: ticketStatusSchema,
  priority: conversationPrioritySchema,
  assignee_id: z.uuid().nullable(),
  origin: ticketOriginSchema,
  opened_message_id: z.uuid().nullable(),
  opened_at: z.string(),
  resolved_at: z.string().nullable(),
  hubspot_ticket_id: z.string().nullable(),
  hubspot_sync_requested_at: z.string().nullable(),
  hubspot_synced_at: z.string().nullable(),
  hubspot_noted_through: z.string().nullable(),
  created_by: z.uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const ticketEventSchema = z.object({
  id: z.uuid(),
  org_id: z.uuid(),
  ticket_id: z.uuid(),
  kind: ticketEventKindSchema,
  actor_id: z.uuid().nullable(),
  details: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});
export type TicketEvent = z.infer<typeof ticketEventSchema>;

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Offen',
  in_progress: 'In Bearbeitung',
  waiting: 'Wartet',
  resolved: 'Erledigt',
};

export const TICKET_ORIGIN_LABELS: Record<TicketOrigin, string> = {
  handoff: 'Übergabe',
  intake: 'Reine Annahme',
  suppressed: 'Unsichere Antwort',
  no_agent: 'Kein Agent',
  draft_only: 'Entwurf',
  pipeline_failure: 'Pipeline-Fehler',
  voice: 'Telefon',
  form: 'Formular',
  manual: 'Manuell',
  takeover: 'Übernahme',
};

/** Ordering used by the attach rule: a later event may only RAISE the priority. */
export const PRIORITY_RANK: Record<ConversationPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

// --- ticket id format ----------------------------------------------------------
// org_settings.ticket_id_format: tokens {N} (plain number), {NNNN…} (zero-padded
// to the token length, NEVER truncated), {YYYY}, {YY} (year in Europe/Berlin).
// Rendering here must stay token-for-token identical to the SQL function
// private.render_ticket_display_id (0030) — the RLS test pins that.

export const DEFAULT_TICKET_ID_FORMAT = '#{N}';
export const TICKET_ID_FORMAT_MAX_LENGTH = 40;

const BRACE_TOKEN_RE = /\{([^{}]*)\}/g;
const KNOWN_TOKEN_RE = /^(N+|YYYY|YY)$/;

function berlinYear(at: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', year: 'numeric' }).format(at);
}

/** Render a display id; unknown tokens stay literal (the validator forbids them anyway). */
export function formatTicketId(format: string, number: number, at: Date = new Date()): string {
  const year = berlinYear(at);
  return format.replace(BRACE_TOKEN_RE, (whole, token: string) => {
    if (/^N+$/.test(token)) {
      const digits = String(number);
      return digits.length >= token.length ? digits : digits.padStart(token.length, '0');
    }
    if (token === 'YYYY') return year;
    if (token === 'YY') return year.slice(-2);
    return whole;
  });
}

export type TicketIdFormatCheck = { ok: true; format: string } | { ok: false; error: string };

/** German-facing validation for the settings form. */
export function validateTicketIdFormat(raw: string): TicketIdFormatCheck {
  const format = raw.trim();
  if (format.length === 0) {
    return {
      ok: false,
      error: 'Bitte ein Ticket-Format angeben (z. B. „#{N}" oder „ZD-{YYYY}-{NNNN}").',
    };
  }
  if (format.length > TICKET_ID_FORMAT_MAX_LENGTH) {
    return {
      ok: false,
      error: `Das Format darf höchstens ${TICKET_ID_FORMAT_MAX_LENGTH} Zeichen lang sein.`,
    };
  }
  const tokens = [...format.matchAll(BRACE_TOKEN_RE)].map((m) => m[1] ?? '');
  const opens = (format.match(/\{/g) ?? []).length;
  const closes = (format.match(/\}/g) ?? []).length;
  if (opens !== tokens.length || closes !== tokens.length) {
    return { ok: false, error: 'Geschweifte Klammern nur für Platzhalter verwenden.' };
  }
  const unknown = tokens.find((t) => !KNOWN_TOKEN_RE.test(t));
  if (unknown !== undefined) {
    return {
      ok: false,
      error: `Unbekannter Platzhalter: {${unknown}}. Erlaubt sind {N}, {NNNN…}, {YYYY} und {YY}.`,
    };
  }
  const numberTokens = tokens.filter((t) => /^N+$/.test(t));
  if (numberTokens.length === 0) {
    return {
      ok: false,
      error:
        'Das Format muss einen Nummern-Platzhalter enthalten ({N} oder z. B. {NNNN} für führende Nullen).',
    };
  }
  if (numberTokens.length > 1) {
    return { ok: false, error: 'Das Format darf nur einen Nummern-Platzhalter enthalten.' };
  }
  return { ok: true, format };
}

export const ticketIdFormatSchema = z
  .string()
  .transform((s) => s.trim())
  .superRefine((value, ctx) => {
    const check = validateTicketIdFormat(value);
    if (!check.ok) ctx.addIssue({ code: 'custom', message: check.error });
  });

/**
 * Subjects the ingest layer invents ("Anruf von +49…", "Eingehender Anruf")
 * count as EMPTY for the attach rule / voice post-call refinement — a real
 * subject from create_ticket or extraction may replace them.
 */
export function isPlaceholderSubject(subject: string | null | undefined): boolean {
  const s = (subject ?? '').trim();
  return s === '' || s.startsWith('Anruf von') || s === 'Eingehender Anruf';
}
