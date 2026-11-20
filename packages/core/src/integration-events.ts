import { z } from 'zod';

// Phase 13c — outbound events ("webhooks") to an org's own end system. The
// outbox rows are written by DB triggers (0036); this module holds what the
// settings UI and the worker share: the event catalog, URL validation and the
// retry schedule. Pure — no I/O.

/** Events a connection can subscribe to (the `ping` test event is always allowed). */
export const INTEGRATION_EVENT_TYPES = [
  'ticket.created',
  'ticket.updated',
  'conversation.created',
  'conversation.updated',
  'contact.updated',
] as const;
export const integrationEventTypeSchema = z.enum(INTEGRATION_EVENT_TYPES);
export type IntegrationEventType = z.infer<typeof integrationEventTypeSchema>;

export const integrationEventTypesSchema = z
  .array(integrationEventTypeSchema)
  .max(INTEGRATION_EVENT_TYPES.length)
  .transform((types) => [...new Set(types)]);

/**
 * Where events are delivered: https only, no credentials in the URL, no
 * fragment. A path and a query string are allowed (many receivers route by
 * them). Public reachability is enforced at delivery time (SSRF guard).
 */
export const apiEventUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.username === '' &&
        url.password === '' &&
        url.hash === '' &&
        url.hostname !== ''
      );
    } catch {
      return false;
    }
  });

/**
 * Delay before the next delivery attempt, indexed by the number of failed
 * attempts so far. Six tries over roughly nine hours, then the event is failed.
 */
export const INTEGRATION_EVENT_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
];
export const INTEGRATION_EVENT_MAX_ATTEMPTS = INTEGRATION_EVENT_RETRY_DELAYS_MS.length + 1;

/** Delay after the `failedAttempts`-th failure, or null when the event is given up. */
export function integrationEventRetryDelayMs(failedAttempts: number): number | null {
  if (failedAttempts < 1 || failedAttempts >= INTEGRATION_EVENT_MAX_ATTEMPTS) return null;
  return INTEGRATION_EVENT_RETRY_DELAYS_MS[failedAttempts - 1] ?? null;
}

/** The JSON body of one delivery (documented contract — docs/phase-13-api-integration.md). */
export interface IntegrationEventPayload {
  /** Event id — also the `webhook-id` header; use it to drop duplicates. */
  id: string;
  type: IntegrationEventType | 'ping';
  /** When the change happened (ISO 8601). */
  created_at: string;
  org_id: string;
  /** Which fields changed and, for status changes, old and new value. */
  changes: Record<string, unknown>;
  /** The current record: exactly one of ticket | conversation | contact (none for ping). */
  data: Record<string, unknown>;
}
