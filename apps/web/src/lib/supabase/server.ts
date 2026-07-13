import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicSupabaseEnv } from '../env';

/** User-scoped client for server components and server actions (RLS applies). */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = publicSupabaseEnv();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // called from a server component — middleware refreshes sessions instead
        }
      },
    },
  });
}
