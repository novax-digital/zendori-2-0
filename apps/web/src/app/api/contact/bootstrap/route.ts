import { NextResponse } from 'next/server';
import { CONTACT_RENDER_SCOPE } from '@zendori/core';
import { issueRenderToken } from '@zendori/channels';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { corsHeaders, preflight } from '@/lib/widget/cors';

// Contact embed bootstrap (Kontaktanfragen, 0034): issues the HMAC render
// token the submit route requires (proves the form was rendered + min-time
// check), reusing the form builder's render-token scheme with its own scope.

export const runtime = 'nodejs';

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders() });
}

export function OPTIONS(): Response {
  return preflight();
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await checkRateLimit('contact-bootstrap-ip', clientIp(request)))) {
    return json({ error: 'Zu viele Anfragen. Bitte versuch es gleich erneut.' }, 429);
  }
  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  if (!masterKey) {
    return json({ error: 'Dienst vorübergehend nicht verfügbar.' }, 503);
  }
  return json({ renderToken: issueRenderToken(masterKey, CONTACT_RENDER_SCOPE) }, 200);
}
