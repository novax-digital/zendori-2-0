// Service-role Supabase client for the worker. Bypasses RLS and passes org_id
// explicitly everywhere — never exposed to the browser (CLAUDE.md §7).
import { createServiceRoleClient, loadWorkerEnv } from '@zendori/core';
import type { SupabaseClient } from '@zendori/core';

let cachedClient: SupabaseClient | undefined;

/** Lazily-created singleton service-role client, built from the worker env. */
export function getServiceClient(): SupabaseClient {
  if (!cachedClient) {
    const env = loadWorkerEnv();
    cachedClient = createServiceRoleClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return cachedClient;
}

/**
 * Missing-column schema skew (worker deployed ahead of a migration): Postgres
 * reports an unknown SELECT column as SQLSTATE 42703, but PostgREST rejects an
 * unknown INSERT/UPDATE payload column from its schema cache as PGRST204 —
 * skew retries must match both.
 */
export function isMissingColumnError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '42703' || code === 'PGRST204';
}

/**
 * Reduce an unknown error to log-safe metadata (name + message only). Never
 * dumps whole error objects, which could carry request/response payloads with
 * message content (CLAUDE.md §7).
 */
export function toErrorInfo(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Unknown', message: String(err) };
}
