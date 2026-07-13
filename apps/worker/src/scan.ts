// Worker self-poll (CLAUDE.md §4). Vercel never enqueues jobs; the worker polls
// the DB for pending inbound messages and pending kb_sources and enqueues
// pg-boss jobs for them. The queues use the 'singleton' policy (see index.ts),
// so singletonKey admits at most one active job per row id; processMessage and
// indexSource additionally re-check the row's state and no-op if it moved on.
import type { PgBoss } from 'pg-boss';
import type { Logger, SupabaseClient } from '@zendori/core';
import { getServiceClient, toErrorInfo } from './db.js';

export const PROCESS_MESSAGE_QUEUE = 'ai.process-message';
export const INDEX_SOURCE_QUEUE = 'kb.index-source';
export const HUBSPOT_SYNC_QUEUE = 'hubspot.sync-conversation';
export const PROCESS_MESSAGE_RETRY_LIMIT = 3;
export const INDEX_SOURCE_RETRY_LIMIT = 2;
export const HUBSPOT_SYNC_RETRY_LIMIT = 3;

const SCAN_INTERVAL_MS = 3_000;
const MESSAGE_BATCH = 20;
const SOURCE_BATCH = 10;
const HUBSPOT_SYNC_BATCH = 20;
// Ordered-by-requested_at window scanned each tick before the JS due-filter (see
// enqueueDueHubspotSyncs): PostgREST cannot compare two columns, so we over-fetch
// the most-recently-requested conversations and filter locally. A freshly-armed
// conversation always has the newest requested_at, so it sits at the front of the
// window and is never starved by older, already-synced rows.
const HUBSPOT_SYNC_CANDIDATES = 100;

export interface ProcessMessageJob {
  messageId: string;
}
export interface IndexSourceJob {
  sourceId: string;
}
export interface HubspotSyncJob {
  conversationId: string;
}

/**
 * Start the scan loop. Returns a stop function that clears the interval.
 * Re-entrancy is guarded so a slow tick never overlaps the next one.
 */
export function startScan(boss: PgBoss, logger: Logger): () => void {
  const supabase = getServiceClient();
  let scanning = false;

  const tick = async (): Promise<void> => {
    if (scanning) return;
    scanning = true;
    try {
      await enqueuePendingMessages(boss, supabase);
      await enqueuePendingSources(boss, supabase);
      await enqueueDueHubspotSyncs(boss, supabase);
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
