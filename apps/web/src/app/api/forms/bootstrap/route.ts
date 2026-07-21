import { NextResponse } from 'next/server';
import { z } from 'zod';
import { issueRenderToken, publicDefinition } from '@zendori/channels';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { corsHeaders, preflight } from '@/lib/widget/cors';
import { findActiveFormByToken, FormDbError } from '@/lib/forms/lookup';

// Public form bootstrap (Phase 10): token → public definition + render token.
// The render token is the anti-bot seam of the submit route (HMAC + min-time);
// both the embed and the hosted page /f/[token] call this endpoint.

const bodySchema = z.object({
  token: z.string().regex(/^[0-9a-f]{32}$/),
});

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders() });
}

export function OPTIONS(): Response {
  return preflight();
}

export async function POST(request: Request): Promise<NextResponse> {
  const allowed = await checkRateLimit('form-bootstrap-ip', clientIp(request));
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

  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  let admin;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    admin = null;
  }
  if (!admin || !masterKey) {
    return json({ error: 'Dienst vorübergehend nicht verfügbar.' }, 503);
  }

  let form;
  try {
    form = await findActiveFormByToken(admin, parsed.data.token);
  } catch (error) {
    if (error instanceof FormDbError) {
      return json({ error: 'Dienst vorübergehend nicht verfügbar.' }, 503);
    }
    throw error;
  }
  if (!form) {
    return json({ error: 'Formular wurde nicht gefunden.' }, 404);
  }

  return json(
    {
      name: form.name,
      definition: publicDefinition(form.definition),
      renderToken: issueRenderToken(masterKey, parsed.data.token),
    },
    200
  );
}
