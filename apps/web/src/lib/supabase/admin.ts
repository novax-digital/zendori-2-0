import 'server-only';
import { createServiceRoleClient } from '@zendori/core';
import type { SupabaseClient } from '@zendori/core';
import { publicSupabaseEnv } from '../env';

/**
 * Service-role client — server-only, bypasses RLS.
 * Returns null if the key is not configured (e.g. preview deployments).
 */
export function createSupabaseAdminClient(): SupabaseClient | null {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return null;
  const { url } = publicSupabaseEnv();
  return createServiceRoleClient(url, serviceRoleKey);
}
