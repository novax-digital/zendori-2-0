import { NextResponse } from 'next/server';
import { z } from 'zod';
import { toPublicDemoStatus } from '@zendori/core';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { corsHeaders, preflight } from '@/lib/widget/cors';
import { DEMO_TOKEN_PATTERN, isVerifyExpired, loadDemoByStatusToken } from '@/lib/demo/server';

// Demo status polling (embed). Takes the embed's status token (HMAC value,
// stored hashed). Returns ONLY the coarse public status — never lead data.

export const runtime = 'nodejs';

const bodySchema = z.object({ token: z.string().regex(DEMO_TOKEN_PATTERN) });

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...corsHeaders(), 'Cache-Control': 'no-store' },
  });
}

export function OPTIONS(): Response {
  return preflight();
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await checkRateLimit('demo-status-ip', clientIp(request)))) {
    return json({ error: 'Zu viele Anfragen.' }, 429);
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'Ungültige Anfrage.' }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return json({ error: 'Ungültige Anfrage.' }, 400);

  let admin;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    admin = null;
  }
  if (!admin) return json({ error: 'Dienst vorübergehend nicht verfügbar.' }, 503);

  const { row, error } = await loadDemoByStatusToken(admin, parsed.data.token);
  if (error) return json({ error: 'Dienst vorübergehend nicht verfügbar.' }, 503);
  if (!row) return json({ error: 'Nicht gefunden.' }, 404);

  // The worker expires stale verifications lazily; report it right away.
  return json({ status: isVerifyExpired(row) ? 'expired' : toPublicDemoStatus(row.status) }, 200);
}
