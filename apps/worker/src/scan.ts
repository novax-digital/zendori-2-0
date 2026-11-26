// Worker self-poll (CLAUDE.md §4). Vercel never enqueues jobs; the worker polls
// the DB for pending inbound messages and pending kb_sources and enqueues
// pg-boss jobs for them. The queues use the 'singleton' policy (see index.ts),
// so singletonKey admits at most one active job per row id; processMessage and
// indexSource additionally re-check the row's state and no-op if it moved on.
import type { PgBoss } from 'pg-boss';
import type { Logger, SupabaseClient } from '@zendori/core';
import { getServiceClient, toErrorInfo } from './db.js';
import { POST_CALL_QUEUE, POST_CALL_RETRY_LIMIT } from './pipeline/post-call.js';
import {
  FORM_NOTIFY_QUEUE,
  FORM_NOTIFY_RETRY_LIMIT,
  type FormNotifyJob,
} from './pipeline/form-notify.js';
import { remindOverdueHandoffs } from './pipeline/handoff-sla.js';
import {
  LEARN_DISTILL_QUEUE,
  LEARN_DISTILL_RETRY_LIMIT,
  type LearnDistillJob,
} from './pipeline/learn.js';
import {
  ACTION_RUN_QUEUE,
  ACTION_RUN_RETRY_LIMIT,
  failStaleRuns,
  type ActionRunJob,
} from './actions/execute.js';
import {
  INTEGRATION_EVENT_QUEUE,
  INTEGRATION_EVENT_RETRY_LIMIT,
  pruneApiIdempotencyKeys,
  pruneIntegrationEvents,
  type IntegrationEventJob,
} from './actions/events.js';
import {
  MCP_SYNC_QUEUE,
  MCP_SYNC_RETRY_LIMIT,
  requestStaleMcpSyncs,
  type McpSyncJob,
} from './actions/mcp-sync.js';
import {
  MEMBER_NOTIFY_QUEUE,
  MEMBER_NOTIFY_RETRY_LIMIT,
  pruneMemberNotifications,
  type MemberNotifyJob,
} from './notifications/deliver.js';
import { workerStripe } from './billing/stripe.js';
import {
  BILLING_SYNC_QUEUE,
  BILLING_SYNC_RETRY_LIMIT,
  isBillingSyncDue,
  type BillingSyncJob,
} from './billing/customer-sync.js';
import {
  INVOICE_DOCUMENT_QUEUE,
  INVOICE_DOCUMENT_RETRY_LIMIT,
  isInvoiceDocumentDue,
  type InvoiceDocumentJob,
} from './billing/invoice-document.js';
import {
  STRIPE_EVENT_QUEUE,
  STRIPE_EVENT_RETRY_LIMIT,
  pruneStripeEvents,
  type StripeEventJob,
} from './billing/stripe-events.js';

export const PROCESS_MESSAGE_QUEUE = 'ai.process-message';
export const INDEX_SOURCE_QUEUE = 'kb.index-source';
export const HUBSPOT_SYNC_QUEUE = 'hubspot.sync-conversation';
export const HUBSPOT_TICKET_SYNC_QUEUE = 'hubspot.sync-ticket';
export const PROCESS_MESSAGE_RETRY_LIMIT = 3;
export const INDEX_SOURCE_RETRY_LIMIT = 2;
export const HUBSPOT_SYNC_RETRY_LIMIT = 3;
const POST_CALL_BATCH = 10;
const FORM_NOTIFY_BATCH = 20;
const LEARN_BATCH = 10;
const ACTION_RUN_BATCH = 20;
const MCP_SYNC_BATCH = 10;
/** The stale-run sweep is a write — once a minute is plenty. */
const STALE_RUN_SWEEP_MS = 60_000;
const INTEGRATION_EVENT_BATCH = 20;
const MEMBER_NOTIFY_BATCH = 20;
const STRIPE_EVENT_BATCH = 20;
const BILLING_SYNC_BATCH = 20;
const INVOICE_DOCUMENT_BATCH = 20;
/** Delivered events are pruned once an hour. */
const EVENT_PRUNE_MS = 60 * 60_000;

// 1 s per CLAUDE.md §4 ("pg-boss-Poll im Sekundentakt"). Trade-off: 1 Hz means
// five lightweight index-backed queries per second against Supabase — negligible
// load — in exchange for ~1.5 s less average pickup latency on every channel.
const SCAN_INTERVAL_MS = 1_000;
const MESSAGE_BATCH = 20;
const SOURCE_BATCH = 10;
const HUBSPOT_SYNC_BATCH = 20;
// Ordered-by-requested_at window scanned each tick before the JS due-filter (see
// enqueueDueHubspotSyncs): PostgREST cannot compare two columns, so we over-fetch
// the most-recently-requested conversations and filter locally. A freshly-armed
// conversation always has the newest requested_at, so it sits at the front of the
// window and is never starved by older, already-synced rows.
const HUBSPOT_SYNC_CANDIDATES = 100;

/**
 * Missing-table detection for pre-migration schema skew: raw PG reports 42P01,
 * but PostgREST answers from its schema cache with PGRST205 — both mean "the
 * migration is not applied yet" and must keep the scan tick silent (a throw
 * would also starve everything after the failing enqueue, incl. the SLA sweep).
 */
function isMissingTable(error: { code?: string }): boolean {
  return error.code === '42P01' || error.code === 'PGRST205';
}

export interface ProcessMessageJob {
  messageId: string;
}
export interface IndexSourceJob {
  sourceId: string;
}
export interface HubspotSyncJob {
  conversationId: string;
}
export interface HubspotTicketSyncJob {
  ticketId: string;
}

/**
 * Start the scan loop. Returns a stop function that clears the interval.
 * Re-entrancy is guarded so a slow tick never overlaps the next one.
 */
export function startScan(boss: PgBoss, logger: Logger): () => void {
  const supabase = getServiceClient();
  let scanning = false;
  let lastStaleRunSweep = 0;
  let lastEventPrune = 0;

  const tick = async (): Promise<void> => {
    if (scanning) return;
    scanning = true;
    try {
      await enqueuePendingMessages(boss, supabase);
      await enqueuePendingSources(boss, supabase);
      await enqueueDueHubspotSyncs(boss, supabase);
      await enqueueDueTicketHubspotSyncs(boss, supabase);
      await enqueueDuePostCalls(boss, supabase);
      await enqueuePendingFormNotifications(boss, supabase);
      await enqueueLearningCandidates(boss, supabase);
      await enqueueQueuedActionRuns(boss, supabase);
      await enqueueRequestedMcpSyncs(boss, supabase);
      if (Date.now() - lastStaleRunSweep >= STALE_RUN_SWEEP_MS) {
        lastStaleRunSweep = Date.now();
        await failStaleRuns(supabase);
      }
      await enqueueDueIntegrationEvents(boss, supabase);
      await enqueueDueMemberNotifications(boss, supabase);
      // Phase 15: Stripe webhook inbox + requested customer syncs (no-ops
      // without STRIPE_SECRET_KEY and before migration 0041).
      await enqueueDueStripeEvents(boss, supabase);
      await enqueueRequestedBillingSyncs(boss, supabase);
      // Phase 15b: issued invoices that still need their PDF or their mail
      await enqueueDueInvoiceDocuments(boss, supabase);
      if (Date.now() - lastEventPrune >= EVENT_PRUNE_MS) {
        lastEventPrune = Date.now();
        await pruneIntegrationEvents(supabase);
        await pruneApiIdempotencyKeys(supabase);
        await pruneMemberNotifications(supabase);
        await pruneStripeEvents(supabase);
        // Phase 14a: re-read MCP tool lists that are older than a day, so a
        // changed tool is noticed without anyone opening the settings page.
        await requestStaleMcpSyncs(supabase);
      }
      // 0018 v1.5: internally rate-limited to one sweep per minute.
      await remindOverdueHandoffs(supabase, logger);
    } catch (err) {
      logger.error({ err: toErrorInfo(err) }, 'scan tick failed');
    } finally {
      scanning = false;
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, SCAN_INTERVAL_MS);
  void tick(); // kick immediately on boot

  return () => clearInterval(interval);
}

async function enqueuePendingMessages(boss: PgBoss, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('direction', 'in')
    .eq('processing_state', 'pending')
    .order('created_at', { ascending: true })
    .limit(MESSAGE_BATCH);
  if (error) throw error;

  for (const row of (data ?? []) as { id: string }[]) {
    await boss.send(PROCESS_MESSAGE_QUEUE, { messageId: row.id } satisfies ProcessMessageJob, {
      singletonKey: row.id,
      retryLimit: PROCESS_MESSAGE_RETRY_LIMIT,
      retryBackoff: true,
    });
  }
}

async function enqueuePendingSources(boss: PgBoss, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from('kb_sources')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(SOURCE_BATCH);
  if (error) throw error;

  for (const row of (data ?? []) as { id: string }[]) {
    await boss.send(INDEX_SOURCE_QUEUE, { sourceId: row.id } satisfies IndexSourceJob, {
      singletonKey: row.id,
      retryLimit: INDEX_SOURCE_RETRY_LIMIT,
      retryBackoff: true,
    });
  }
}

/**
 * Enqueue conversations whose HubSpot sync is "due" (§ Phase 6): a sync was
 * requested and not yet reflected — hubspot_sync_requested_at is set AND
 * (hubspot_synced_at is null OR hubspot_synced_at < hubspot_sync_requested_at).
 * PostgREST cannot compare two columns, so we fetch the most-recently-requested
 * candidates (index-backed) and apply the timestamp comparison in JS.
 */
async function enqueueDueHubspotSyncs(boss: PgBoss, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, hubspot_sync_requested_at, hubspot_synced_at')
    .not('hubspot_sync_requested_at', 'is', null)
    .order('hubspot_sync_requested_at', { ascending: false })
    .limit(HUBSPOT_SYNC_CANDIDATES);
  if (error) throw error;

  const rows = (data ?? []) as {
    id: string;
    hubspot_sync_requested_at: string;
    hubspot_synced_at: string | null;
  }[];

  let enqueued = 0;
  for (const row of rows) {
    if (enqueued >= HUBSPOT_SYNC_BATCH) break;
    const requestedMs = Date.parse(row.hubspot_sync_requested_at);
    const syncedMs = row.hubspot_synced_at !== null ? Date.parse(row.hubspot_synced_at) : null;
    const isDue = syncedMs === null || syncedMs < requestedMs;
    if (!isDue) continue;
    await boss.send(HUBSPOT_SYNC_QUEUE, { conversationId: row.id } satisfies HubspotSyncJob, {
      singletonKey: row.id,
      retryLimit: HUBSPOT_SYNC_RETRY_LIMIT,
      retryBackoff: true,
    });
    enqueued += 1;
  }
}

/**
 * Ticket stream (Phase 11b): same due predicate over tickets. A worker deployed
 * before migration 0030 sees a missing table and stays silent.
 */
async function enqueueDueTicketHubspotSyncs(boss: PgBoss, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from('tickets')
    .select('id, hubspot_sync_requested_at, hubspot_synced_at')
    .not('hubspot_sync_requested_at', 'is', null)
    .order('hubspot_sync_requested_at', { ascending: false })
    .limit(HUBSPOT_SYNC_CANDIDATES);
  if (error) {
    if (isMissingTable(error)) return;
    throw error;
  }
  const rows = (data ?? []) as {
    id: string;
    hubspot_sync_requested_at: string;
    hubspot_synced_at: string | null;
  }[];
  let enqueued = 0;
  for (const row of rows) {
    if (enqueued >= HUBSPOT_SYNC_BATCH) break;
    const requestedMs = Date.parse(row.hubspot_sync_requested_at);
    const syncedMs = row.hubspot_synced_at !== null ? Date.parse(row.hubspot_synced_at) : null;
    if (!(syncedMs === null || syncedMs < requestedMs)) continue;
    await boss.send(HUBSPOT_TICKET_SYNC_QUEUE, { ticketId: row.id } satisfies HubspotTicketSyncJob, {
      singletonKey: row.id,
      retryLimit: HUBSPOT_SYNC_RETRY_LIMIT,
      retryBackoff: true,
    });
    enqueued += 1;
  }
}

/** Enqueue pending form-forwarding mails (Phase 10). */
async function enqueuePendingFormNotifications(
  boss: PgBoss,
  supabase: SupabaseClient
): Promise<void> {
  const { data, error } = await supabase
    .from('form_notifications')
    .select('id')
    .eq('state', 'pending')
    .order('created_at', { ascending: true })
    .limit(FORM_NOTIFY_BATCH);
  if (error) {
    // form_notifications does not exist until migration 0019 is applied — stay silent.
    if (isMissingTable(error as { code?: string })) return;
    throw error;
  }

  for (const row of (data ?? []) as { id: string }[]) {
    await boss.send(FORM_NOTIFY_QUEUE, { notificationId: row.id } satisfies FormNotifyJob, {
      singletonKey: row.id,
      retryLimit: FORM_NOTIFY_RETRY_LIMIT,
      retryBackoff: true,
    });
  }
}

/** Enqueue learning candidates awaiting distillation (learning loop, 0020). */
async function enqueueLearningCandidates(boss: PgBoss, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from('learned_answers')
    .select('id')
    .eq('status', 'candidate')
    .order('created_at', { ascending: true })
    .limit(LEARN_BATCH);
  if (error) {
    // learned_answers does not exist until migration 0020 is applied — stay silent.
    if (isMissingTable(error as { code?: string })) return;
    throw error;
  }

  for (const row of (data ?? []) as { id: string }[]) {
    await boss.send(LEARN_DISTILL_QUEUE, { learnedAnswerId: row.id } satisfies LearnDistillJob, {
      singletonKey: row.id,
      retryLimit: LEARN_DISTILL_RETRY_LIMIT,
      retryBackoff: true,
    });
  }
}

/** Enqueue data-action runs waiting for the worker: test runs + approved runs (Phase 13). */
async function enqueueQueuedActionRuns(boss: PgBoss, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from('action_runs')
    .select('id')
    .eq('state', 'queued')
    .order('created_at', { ascending: true })
    .limit(ACTION_RUN_BATCH);
  if (error) {
    // action_runs does not exist until migration 0035 is applied — stay silent.
    if (isMissingTable(error as { code?: string })) return;
    throw error;
  }

  for (const row of (data ?? []) as { id: string }[]) {
    await boss.send(ACTION_RUN_QUEUE, { runId: row.id } satisfies ActionRunJob, {
      singletonKey: row.id,
      retryLimit: ACTION_RUN_RETRY_LIMIT,
    });
  }
}

/**
 * Enqueue MCP connections whose tool list was requested (Phase 14a). The job
 * claims the connection itself, so sending it again while a read is running is
 * harmless. Silent before migration 0039 (missing columns).
 */
async function enqueueRequestedMcpSyncs(boss: PgBoss, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from('api_connections')
    .select('id')
    .eq('kind', 'mcp')
    .not('mcp_sync_requested_at', 'is', null)
    .order('mcp_sync_requested_at', { ascending: true })
    .limit(MCP_SYNC_BATCH);
  if (error) {
    const code = (error as { code?: string }).code;
    // 42703 / PGRST204: the 0039 columns are not there yet
    if (isMissingTable(error as { code?: string }) || code === '42703' || code === 'PGRST204') {
      return;
    }
    throw error;
  }

  for (const row of (data ?? []) as { id: string }[]) {
    await boss.send(MCP_SYNC_QUEUE, { connectionId: row.id } satisfies McpSyncJob, {
      singletonKey: row.id,
      retryLimit: MCP_SYNC_RETRY_LIMIT,
    });
  }
}

/**
 * Enqueue outbox events whose delivery time has come (Phase 13c). The retry
 * schedule lives in the row (next_attempt_at); the job itself never retries.
 */
async function enqueueDueIntegrationEvents(boss: PgBoss, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from('integration_events')
    .select('id')
    .eq('state', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(INTEGRATION_EVENT_BATCH);
  if (error) {
    // integration_events does not exist until migration 0036 is applied — stay silent.
    if (isMissingTable(error as { code?: string })) return;
    throw error;
  }

  for (const row of (data ?? []) as { id: string }[]) {
    await boss.send(INTEGRATION_EVENT_QUEUE, { eventId: row.id } satisfies IntegrationEventJob, {
      singletonKey: row.id,
      retryLimit: INTEGRATION_EVENT_RETRY_LIMIT,
    });
  }
}

/**
 * Enqueue member notifications whose time has come (0038). Like the event
 * outbox, the schedule lives in the row; the job itself never retries.
 */
async function enqueueDueMemberNotifications(boss: PgBoss, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from('member_notifications')
    .select('id')
    .eq('state', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(MEMBER_NOTIFY_BATCH);
  if (error) {
    // member_notifications does not exist until migration 0038 is applied — stay silent.
    if (isMissingTable(error as { code?: string })) return;
    throw error;
  }

  for (const row of (data ?? []) as { id: string }[]) {
    await boss.send(MEMBER_NOTIFY_QUEUE, { notificationId: row.id } satisfies MemberNotifyJob, {
      singletonKey: row.id,
      retryLimit: MEMBER_NOTIFY_RETRY_LIMIT,
    });
  }
}

/**
 * Enqueue stored Stripe events whose time has come (Phase 15, 0041). Only events
 * of the mode of the worker's own key — it cannot read the others' objects. The
 * schedule lives in the row; the job itself never retries.
 */
async function enqueueDueStripeEvents(boss: PgBoss, supabase: SupabaseClient): Promise<void> {
  const stripe = workerStripe();
  if (!stripe) return;
  const { data, error } = await supabase
    .from('stripe_events')
    .select('event_id')
    .eq('state', 'pending')
    .eq('livemode', stripe.livemode)
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(STRIPE_EVENT_BATCH);
  if (error) {
    // stripe_events does not exist until migration 0041 is applied — stay silent.
    if (isMissingTable(error as { code?: string })) return;
    throw error;
  }

  for (const row of (data ?? []) as { event_id: string }[]) {
    await boss.send(STRIPE_EVENT_QUEUE, { eventId: row.event_id } satisfies StripeEventJob, {
      singletonKey: row.event_id,
      retryLimit: STRIPE_EVENT_RETRY_LIMIT,
    });
  }
}

/**
 * Enqueue organizations whose Stripe customer has to be brought up to date
 * (the web app set sync_requested_at). The retry schedule lives in the row.
 */
async function enqueueRequestedBillingSyncs(boss: PgBoss, supabase: SupabaseClient): Promise<void> {
  const stripe = workerStripe();
  if (!stripe) return;
  const { data, error } = await supabase
    .from('billing_stripe_customers')
    .select('org_id, sync_requested_at, sync_next_attempt_at')
    .eq('livemode', stripe.livemode)
    .not('sync_requested_at', 'is', null)
    .order('sync_requested_at', { ascending: true })
    .limit(BILLING_SYNC_BATCH);
  if (error) {
    // billing_stripe_customers does not exist until migration 0041 — stay silent.
    if (isMissingTable(error as { code?: string })) return;
    throw error;
  }

  const nowMs = Date.now();
  for (const row of (data ?? []) as {
    org_id: string;
    sync_requested_at: string | null;
    sync_next_attempt_at: string | null;
  }[]) {
    if (!isBillingSyncDue(row, nowMs)) continue;
    await boss.send(BILLING_SYNC_QUEUE, { orgId: row.org_id } satisfies BillingSyncJob, {
      singletonKey: row.org_id,
      retryLimit: BILLING_SYNC_RETRY_LIMIT,
    });
  }
}

/**
 * Enqueue issued invoices whose PDF or mail is still to do (0046). A no-op
 * before the migration.
 */
async function enqueueDueInvoiceDocuments(boss: PgBoss, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from('billing_invoices')
    .select('id, pdf_state, mail_state, next_attempt_at')
    .or('pdf_state.eq.pending,mail_state.eq.pending')
    .order('created_at', { ascending: true })
    .limit(INVOICE_DOCUMENT_BATCH);
  if (error) {
    if (isMissingTable(error as { code?: string })) return;
    throw error;
  }
  const nowMs = Date.now();
  for (const row of (data ?? []) as {
    id: string;
    pdf_state: string;
    mail_state: string;
    next_attempt_at: string | null;
  }[]) {
    if (!isInvoiceDocumentDue(row, nowMs)) continue;
    await boss.send(INVOICE_DOCUMENT_QUEUE, { invoiceId: row.id } satisfies InvoiceDocumentJob, {
      singletonKey: row.id,
      retryLimit: INVOICE_DOCUMENT_RETRY_LIMIT,
    });
  }
}

/** Enqueue ended voice calls that still need the post-call AI (Phase 9). */
async function enqueueDuePostCalls(boss: PgBoss, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from('voice_calls')
    .select('id')
    .is('post_processed_at', null)
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: true })
    .limit(POST_CALL_BATCH);
  if (error) {
    // voice_calls does not exist until migration 0009 is applied — stay silent.
    if (isMissingTable(error as { code?: string })) return;
    throw error;
  }

  for (const row of (data ?? []) as { id: string }[]) {
    await boss.send(
      POST_CALL_QUEUE,
      { voiceCallId: row.id },
      {
        singletonKey: row.id,
        retryLimit: POST_CALL_RETRY_LIMIT,
        retryBackoff: true,
      }
    );
  }
}
