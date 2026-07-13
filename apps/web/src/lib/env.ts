/**
 * Public Supabase config. NEXT_PUBLIC_* vars are inlined at build time,
 * so this works in server components, middleware and the browser alike.
 */
export function publicSupabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set');
  }
  return { url, anonKey };
}

export function appUrl(): string {
  return process.env.APP_URL ?? 'http://localhost:3000';
}
