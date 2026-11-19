import { NextResponse } from 'next/server';
import { DEMO_RENDER_SCOPE } from '@zendori/core';
import { issueRenderToken } from '@zendori/channels';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { corsHeaders, preflight } from '@/lib/widget/cors';

// Demo embed bootstrap (Demo-Anruf, 0032): issues the HMAC render token the
// request route requires (proves the form was rendered + min-time check),
// reusing the form builder's render-token scheme with a demo-only scope.

export const runtime = 'nodejs';

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders() });
}

export function OPTIONS(): Response {
  return preflight();
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await checkRateLimit('demo-bootstrap-ip', clientIp(request)))) {
    return json({ error: 'Zu viele Anfragen. Bitte versuchen Sie es gleich erneut.' }, 429);
  }
  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  if (!masterKey) {
    return json({ error: 'Dienst vorübergehend nicht verfügbar.' }, 503);
  }
  return json({ renderToken: issueRenderToken(masterKey, DEMO_RENDER_SCOPE) }, 200);
}
