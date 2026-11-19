import { cache } from 'react';
import { createSupabaseServerClient } from './server';

export type SessionUser = { id: string; email: string };

/**
 * The signed-in user of this request, for READ paths (pages, layouts).
 *
 * auth.getClaims() verifies the access token's signature locally against the
 * project's public signing keys (JWKS, cached in memory for 10 minutes), so a
 * page render no longer pays a round trip to the auth server just to learn who
 * is asking. When that yields nothing (symmetric key, verification hiccup) we
 * ask the auth server as before, so the result is never weaker than getUser().
 *
 * Deduplicated per request by React cache(): layout, page and helpers share one
 * lookup. Server actions (writes) keep calling auth.getUser() themselves.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  try {
    const { data } = await supabase.auth.getClaims();
    const claims = data?.claims;
    if (claims && typeof claims.sub === 'string' && claims.sub) {
      return { id: claims.sub, email: typeof claims.email === 'string' ? claims.email : '' };
    }
  } catch {
    // fall through to the auth server
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? { id: user.id, email: user.email ?? '' } : null;
});
