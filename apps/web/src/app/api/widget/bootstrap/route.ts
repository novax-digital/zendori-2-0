import { NextResponse } from 'next/server';
import { z } from 'zod';
import { publicSupabaseEnv } from '@/lib/env';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { corsHeaders, preflight } from '@/lib/widget/cors';
import { findWidgetChannelByToken, WidgetDbError } from '@/lib/widget/session';

const bodySchema = z.object({
  token: z.string().regex(/^[0-9a-f]{32}$/),
});

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders() });
}

function serviceUnavailable(): NextResponse {
  return json(
    { error: 'Dienst vorübergehend nicht verfügbar. Bitte versuchen Sie es gleich erneut.' },
    503
  );
}

export function OPTIONS(): Response {
  return preflight();
}

export async function POST(request: Request): Promise<NextResponse> {
  const allowed = await checkRateLimit('widget-bootstrap-ip', clientIp(request));
  if (!allowed) {
    return json({ error: 'Zu viele Anfragen. Bitte versuchen Sie es gleich erneut.' }, 429);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'Ungültige Anfrage.' }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'Ungültige Anfrage.' }, 400);
  }

  let admin;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return serviceUnavailable();
  }
  if (!admin) {
    return serviceUnavailable();
  }

  let channel;
  try {
    channel = await findWidgetChannelByToken(admin, parsed.data.token);
  } catch (error) {
    if (error instanceof WidgetDbError) return serviceUnavailable();
    throw error;
  }
  if (!channel) {
    return json({ error: 'Widget wurde nicht gefunden.' }, 404);
  }

  let realtime: { url: string; anonKey: string };
  try {
    const { url, anonKey } = publicSupabaseEnv();
    realtime = { url, anonKey };
  } catch {
    return serviceUnavailable();
  }

  return json({ theme: channel.config.theme, realtime }, 200);
}
