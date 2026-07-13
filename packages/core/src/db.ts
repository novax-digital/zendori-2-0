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
