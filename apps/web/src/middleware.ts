import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { publicSupabaseEnv } from './lib/env';

// Only /login is public — self-registration is disabled (admins create accounts).
// /register still exists but immediately redirects to /login.
const PUBLIC_PATHS = ['/login', '/register'];

export async function middleware(request: NextRequest) {
  // public surfaces that authenticate themselves and are called by third
  // parties (customer sites, Resend/WhatsApp/voice webhooks) — never redirect
  // these to /login. Widget API + script, and provider webhooks under /api/hooks/.
  const path = request.nextUrl.pathname;
  if (
    path === '/widget.js' ||
    path === '/form.js' ||
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

  // refresh the session; do not run logic between client creation and getUser()
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  if (!user && !isPublic) {
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
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|wav|mp3)$).*)',
  ],
};
