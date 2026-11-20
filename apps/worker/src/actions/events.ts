// Phase 13c — outbound events: delivers the outbox rows that the 0036 triggers
// write (integration_events) to the event URL of an org's API connection, as a
// signed JSON POST. Same HTTP client, credentials, SSRF guard and egress IP as
// the data actions.
//
// Reliability: the row is the source of truth. A delivery attempt first takes a
// lease on the row (next_attempt_at pushed forward), so two jobs can never send
// the same attempt; failures reschedule with the backoff from
// @zendori/core (six tries over ~9 hours), then the event is marked failed.
// The receiver gets the event id as `webhook-id` / Idempotency-Key and must
// treat a repeated id as a duplicate — delivery is at-least-once.
//
// Content: the outbox row is content-free. The payload is built here from the
// CURRENT record (ticket / conversation / contact fields, never message
// bodies). Nothing of it is logged (§7).
import {
  apiConnectionConfigSchema,
  integrationEventRetryDelayMs,
  isMissingRelationError,
  type IntegrationEventPayload,
  type SupabaseClient,
} from '@zendori/core';
import { CustomApiError, callCustomApi } from '@zendori/integrations';
import { assertPublicUrl } from '../pipeline/index-source.js';
import { toErrorInfo } from '../db.js';
import { decryptConnectionSecrets, type ActionDeps } from './execute.js';

export const INTEGRATION_EVENT_QUEUE = 'integration.event';
/** Retries are scheduled in the row (next_attempt_at), not by pg-boss. */
export const INTEGRATION_EVENT_RETRY_LIMIT = 0;
export const INTEGRATION_EVENT_TIMEOUT_MS = 10_000;
/** While an attempt runs, the row is invisible to the scan for this long. */
export const INTEGRATION_EVENT_LEASE_MS = 5 * 60_000;
/** Delivered and given-up events are kept this long for the delivery log. */
export const INTEGRATION_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface IntegrationEventJob {
  eventId: string;
}

interface EventRow {
  id: string;
  org_id: string;
  connection_id: string;
  event_type: string;
  entity_type: 'ticket' | 'conversation' | 'contact' | 'ping';
  entity_id: string | null;
  details: unknown;
  attempts: number;
  created_at: string;
}

interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company?: string | null;
}

// --- payload ---------------------------------------------------------------------

/** The end system's own id for a Zendori record, if it linked one (0037). */
async function loadExternalId(
  supabase: SupabaseClient,
  connectionId: string,
  entityType: 'ticket' | 'conversation' | 'contact',
  entityId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('external_links')
    .select('external_id')
    .eq('connection_id', connectionId)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .maybeSingle();
  if (error) {
    if (isMissingRelationError(error)) return null; // pre-0037
    throw error;
  }
  return (data as { external_id: string } | null)?.external_id ?? null;
}

async function loadContactPayload(
  supabase: SupabaseClient,
  event: EventRow,
  contactId: string | null
): Promise<Record<string, unknown> | null> {
  if (!contactId) return null;
  const { data, error } = await supabase
    .from('contacts')
    .select('id, name, email, phone, company')
    .eq('org_id', event.org_id)
    .eq('id', contactId)
    .maybeSingle();
  if (error) throw error;
  const contact = data as ContactRow | null;
  if (!contact) return null;
  return {
    id: contact.id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    company: contact.company ?? null,
    external_id: await loadExternalId(supabase, event.connection_id, 'contact', contact.id),
  };
}

/** The current record for the event, or null when it no longer exists. */
async function loadEventData(
  supabase: SupabaseClient,
  event: EventRow
): Promise<Record<string, unknown> | null> {
  if (event.entity_type === 'ping') return {};
  if (!event.entity_id) return null;

  if (event.entity_type === 'contact') {
    const contact = await loadContactPayload(supabase, event, event.entity_id);
    return contact ? { contact } : null;
  }

  if (event.entity_type === 'ticket') {
    const { data, error } = await supabase
      .from('tickets')
      .select(
        'id, display_id, number, subject, description, category, status, priority, origin, conversation_id, channel_id, contact_id, assignee_id, opened_at, resolved_at'
      )
      .eq('org_id', event.org_id)
      .eq('id', event.entity_id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const { contact_id: contactId, ...ticket } = data as Record<string, unknown> & {
      contact_id: string | null;
    };
    return {
      ticket: {
        ...ticket,
        external_id: await loadExternalId(supabase, event.connection_id, 'ticket', event.entity_id),
        contact: await loadContactPayload(supabase, event, contactId),
      },
    };
  }

  const { data, error } = await supabase
    .from('conversations')
    .select(
      'id, subject, status, mode, priority, assignee_id, channel_id, contact_id, last_message_at, created_at'
    )
    .eq('org_id', event.org_id)
    .eq('id', event.entity_id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const {
    contact_id: contactId,
    channel_id: channelId,
    ...conversation
  } = data as Record<string, unknown> & { contact_id: string | null; channel_id: string };
  const { data: channelRow, error: channelError } = await supabase
    .from('channels')
    .select('id, type, name')
    .eq('org_id', event.org_id)
    .eq('id', channelId)
    .maybeSingle();
  if (channelError) throw channelError;
  return {
    conversation: {
      ...conversation,
      external_id: await loadExternalId(
        supabase,
        event.connection_id,
        'conversation',
        event.entity_id
      ),
      channel: channelRow ?? null,
      contact: await loadContactPayload(supabase, event, contactId),
    },
  };
}

export function buildEventPayload(
  event: Pick<EventRow, 'id' | 'event_type' | 'created_at' | 'org_id' | 'details'>,
  data: Record<string, unknown>
): IntegrationEventPayload {
  return {
    id: event.id,
    type: event.event_type as IntegrationEventPayload['type'],
    created_at: event.created_at,
    org_id: event.org_id,
    changes:
      event.details !== null && typeof event.details === 'object' && !Array.isArray(event.details)
        ? (event.details as Record<string, unknown>)
        : {},
    data,
  };
}

// --- delivery --------------------------------------------------------------------

type AttemptResult =
  | { kind: 'sent'; status: number }
  /** Worth another try later (transport problem, 4xx/5xx from the receiver). */
  | { kind: 'retry'; status: number | null; error: string }
  /** Will never succeed (connection gone/paused, record deleted, bad config). */
  | { kind: 'dead'; error: string };

async function attemptDelivery(deps: ActionDeps, event: EventRow): Promise<AttemptResult> {
  const { data: connRow, error } = await deps.supabase
    .from('api_connections')
    .select('event_url, config, is_active')
    .eq('org_id', event.org_id)
    .eq('id', event.connection_id)
    .maybeSingle();
  if (error) throw error;
  const connection = connRow as {
    event_url: string | null;
    config: unknown;
    is_active: boolean;
  } | null;
  if (!connection || !connection.is_active || !connection.event_url) {
    return { kind: 'dead', error: 'connection_inactive' };
  }
  const config = apiConnectionConfigSchema.safeParse(connection.config ?? {});
  if (!config.success) return { kind: 'dead', error: 'config_invalid' };
  const secrets = await decryptConnectionSecrets(config.data, deps.masterKey);
  if (!secrets) return { kind: 'dead', error: 'config_invalid' };

  const data = await loadEventData(deps.supabase, event);
  if (data === null) return { kind: 'dead', error: 'entity_gone' };

  try {
    const response = await callCustomApi({
      url: connection.event_url,
      method: 'POST',
      body: JSON.stringify(buildEventPayload(event, data)),
      auth: secrets.auth,
      signingSecret: secrets.signingSecret,
      // stable across retries: the receiver dedupes on it
      requestId: event.id,
      timeoutMs: INTEGRATION_EVENT_TIMEOUT_MS,
      // the answer is irrelevant beyond its status — do not buffer large bodies
      maxResponseBytes: 16 * 1024,
      fetchImpl: deps.fetchImpl,
      assertUrl: deps.assertUrl ?? assertPublicUrl,
    });
    if (response.status >= 200 && response.status < 300) {
      return { kind: 'sent', status: response.status };
    }
    return { kind: 'retry', status: response.status, error: 'http_error' };
  } catch (err) {
    if (err instanceof CustomApiError) {
      // a 2xx with an oversized body still means "received"
      if (err.code === 'response_too_large') return { kind: 'sent', status: 200 };
      return { kind: 'retry', status: null, error: err.code };
    }
    throw err;
  }
}

/**
 * One delivery attempt for one outbox row. Idempotent per attempt: only a
 * pending row whose time has come can be leased, so a duplicate job is a no-op.
 */
export async function deliverIntegrationEvent(deps: ActionDeps, eventId: string): Promise<void> {
  const now = Date.now();
  const { data: leased, error: leaseError } = await deps.supabase
    .from('integration_events')
    .update({ next_attempt_at: new Date(now + INTEGRATION_EVENT_LEASE_MS).toISOString() })
    .eq('id', eventId)
    .eq('state', 'pending')
    .lte('next_attempt_at', new Date(now).toISOString())
    .select(
      'id, org_id, connection_id, event_type, entity_type, entity_id, details, attempts, created_at'
    );
  if (leaseError) throw leaseError;
  const event = ((leased ?? []) as EventRow[])[0];
  if (!event) return; // not due, already handled, or gone

  let result: AttemptResult;
  try {
    result = await attemptDelivery(deps, event);
  } catch (err) {
    // Unexpected (database) problem: count the attempt and retry on schedule.
    deps.logger.error({ eventId, err: toErrorInfo(err) }, 'integration event attempt failed');
    result = { kind: 'retry', status: null, error: 'internal' };
  }

  const attempts = event.attempts + 1;
  const retryDelay = result.kind === 'retry' ? integrationEventRetryDelayMs(attempts) : null;
  const patch =
    result.kind === 'sent'
      ? {
          state: 'sent',
          attempts,
          last_status: result.status,
          last_error: null,
          sent_at: new Date().toISOString(),
        }
      : result.kind === 'retry' && retryDelay !== null
        ? {
            attempts,
            last_status: result.status,
            last_error: result.error,
            next_attempt_at: new Date(Date.now() + retryDelay).toISOString(),
          }
        : {
            state: 'failed',
            attempts,
            last_status: result.kind === 'retry' ? result.status : null,
            last_error: result.error,
          };
  const { error: updateError } = await deps.supabase
    .from('integration_events')
    .update(patch)
    .eq('id', event.id);
  if (updateError) throw updateError;

  deps.logger.info(
    {
      eventId,
      eventType: event.event_type,
      outcome: 'state' in patch ? patch.state : 'retry',
      attempts,
      ...(result.kind === 'sent' ? { status: result.status } : { error: result.error }),
    },
    'integration event delivery'
  );
}

/** Replay window of the public API's Idempotency-Key store (0037). */
export const API_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Forget idempotency keys of the public API after the replay window. */
export async function pruneApiIdempotencyKeys(supabase: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - API_IDEMPOTENCY_RETENTION_MS).toISOString();
  const { error } = await supabase.from('api_idempotency_keys').delete().lt('created_at', cutoff);
  if (error && !isMissingRelationError(error)) throw error;
}

/** Drop delivered / given-up events once they are older than the retention window. */
export async function pruneIntegrationEvents(supabase: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - INTEGRATION_EVENT_RETENTION_MS).toISOString();
  const { error } = await supabase
    .from('integration_events')
    .delete()
    .in('state', ['sent', 'failed'])
    .lt('created_at', cutoff);
  if (error && !isMissingRelationError(error)) throw error;
}
