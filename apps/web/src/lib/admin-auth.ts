import 'server-only';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export type PlatformAdmin = { userId: string; email: string };

/**
 * Gate for the Zendori superadmin area (/admin). Redirects to /login when not
 * signed in, or to / when the user is not a platform admin. The self-select RLS
 * policy on platform_admins lets a user read only their own row; a missing row
 * (or the table not existing yet, pre-migration) fails closed → bounced to /.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdmin> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data } = await supabase
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!data) redirect('/');

  return { userId: user.id, email: user.email ?? '' };
}
