import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Request header that names the API connection a change comes FROM (Phase 13d).
 * The 0036 outbox triggers read it and do not report the change back to that
 * connection (echo suppression). Honoured for the service role only.
 */
export const ORIGIN_CONNECTION_HEADER = 'x-zendori-origin-connection';

/**
 * Service-role client for trusted server-side code (worker, server actions).
 * Bypasses RLS — never expose to the browser.
 *
 * `originConnectionId` tags every request of this client as coming from that
 * API connection — used by the public API routes, one client per request.
 */
export function createServiceRoleClient(
  url: string,
  serviceRoleKey: string,
  options?: { originConnectionId?: string }
): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(options?.originConnectionId
      ? { global: { headers: { [ORIGIN_CONNECTION_HEADER]: options.originConnectionId } } }
      : {}),
  });
}

export type { SupabaseClient };

// --- schema-skew helpers (Phase 11) --------------------------------------------
// Code may run before or after a migration (web deploys on push, the worker
// image is pulled manually, `db push` is manual): callers treat a missing
// table/column as "feature not available yet" instead of failing.

/** Missing table/relation: Postgres 42P01 or PostgREST PGRST205 (schema cache). */
export function isMissingRelationError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '42P01' || code === 'PGRST205';
}

/** Missing column: Postgres 42703 (select) or PostgREST PGRST204 (insert/update payload). */
export function isMissingColumnError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '42703' || code === 'PGRST204';
}
