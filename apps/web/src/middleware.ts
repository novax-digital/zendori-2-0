import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { publicSupabaseEnv } from './lib/env';

// Public: /login, /register (redirects to /login — self-registration is
// disabled) and /invite (team invitees open their password-setup link without a
// session; the page authenticates itself by redeeming the mailed OTP token).
// '/passwort-*': forgot password + the reset link target (signed out by definition)
const PUBLIC_PATHS = ['/login', '/register', '/invite', '/passwort-vergessen', '/passwort-neu'];

export async function middleware(request: NextRequest) {
  // public surfaces that authenticate themselves and are called by third
  // parties (customer sites, Resend/WhatsApp/voice webhooks) — never redirect
  // these to /login. Widget API + script, and provider webhooks under /api/hooks/.
  // Demo-Anruf: embed script, public demo API, hosted demo page.
  const path = request.nextUrl.pathname;
  if (
    path === '/widget.js' ||
    path === '/form.js' ||
    path === '/demo.js' ||
    path === '/demo' ||
    path.startsWith('/api/demo/') ||
    // Kontaktanfragen: embed script + public contact API
    path === '/contact.js' ||
    path.startsWith('/api/contact/') ||
    path.startsWith('/api/widget/') ||
    path.startsWith('/api/forms/') ||
    path.startsWith('/api/hooks/') ||
    path.startsWith('/f/')
  ) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });
  const { url, anonKey } = publicSupabaseEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // Refresh the session; do not run logic between client creation and this
  // check. getClaims() refreshes an expired session like getUser() does, but
  // verifies the access token's signature locally against the project's public
  // signing keys (JWKS cached in memory) — no auth-server round trip on every
  // navigation. When it yields nothing we still ask the auth server before
  // redirecting, so a verification hiccup never bounces a signed-in user.
  let signedIn = false;
  try {
    const { data } = await supabase.auth.getClaims();
    signedIn = typeof data?.claims?.sub === 'string' && data.claims.sub !== '';
  } catch {
    // fall through to the auth server
  }
  if (!signedIn) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    signedIn = Boolean(user);
  }

  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  if (!signedIn && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', path);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  // wav/mp3: static voice-preview samples under /voice-samples — public assets,
  // never a login redirect (an <audio> element cannot follow one meaningfully).
  // webmanifest: browsers fetch it without cookies, so it used to be redirected
  // to /login on every page load (a wasted auth check, and no manifest).
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|wav|mp3|webmanifest)$).*)',
  ],
};
