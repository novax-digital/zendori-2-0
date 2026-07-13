import { createBrowserClient } from '@supabase/ssr';
import { publicSupabaseEnv } from '../env';

/** Browser client for client components (user session via cookies, RLS applies). */
export function createSupabaseBrowserClient() {
  const { url, anonKey } = publicSupabaseEnv();
  return createBrowserClient(url, anonKey);
}
