import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role client for trusted server-side code (worker, server actions).
 * Bypasses RLS — never expose to the browser.
 */
export function createServiceRoleClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
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
