import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createLogger,
  DEMO_CODE_MAX_SENDS,
  DEMO_CODE_RESEND_COOLDOWN_SECONDS,
  isGermanMobile,
  toPublicDemoStatus,
} from '@zendori/core';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { corsHeaders, preflight } from '@/lib/widget/cors';
import {
  closeUnverifiedDemo,
  DEMO_SEND_FAILURES,
  DEMO_TOKEN_PATTERN,
  isVerifyExpired,
  loadDemoByStatusToken,
} from '@/lib/demo/server';
import { sendDemoCode } from '@/lib/demo/verify';

// Demo verification code resend (0032): "Code erneut senden" / "Code per
// Anruf". Bounded per request (DEMO_CODE_MAX_SENDS, cooldown) — the slot is
// claimed with a conditional update before Twilio is called, so parallel
// clicks cannot exceed the budget. Landlines always get a call.

export const runtime = 'nodejs';
export const maxDuration = 15;

const log = createLogger('demo-resend');

const bodySchema = z.object({
  token: z.string().regex(DEMO_TOKEN_PATTERN),
  channel: z.enum(['sms', 'call']).optional(),
});

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...corsHeaders(), 'Cache-Control': 'no-store' },
  });
}

export function OPTIONS(): Response {
  return preflight();
}

const UNAVAILABLE = {
  error: 'Der Dienst ist vorübergehend nicht verfügbar. Bitte versuch es gleich erneut.',
  code: 'unavailable',
};

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await checkRateLimit('demo-resend-ip', clientIp(request)))) {
    return json(
      { error: 'Zu viele Anfragen. Bitte warte einen Moment.', code: 'rate_limited' },
      429
    );
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'Ungültige Anfrage.', code: 'invalid' }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return json({ error: 'Ungültige Anfrage.', code: 'invalid' }, 400);

  let admin;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    admin = null;
  }
  if (!admin) return json(UNAVAILABLE, 503);

  const { row, error } = await loadDemoByStatusToken(admin, parsed.data.token);
  if (error) return json(UNAVAILABLE, 503);
  if (!row) return json({ error: 'Nicht gefunden.', code: 'not_found' }, 404);
  if (row.status !== 'awaiting_confirmation') {
    return json({ ok: true, status: toPublicDemoStatus(row.status) }, 200);
  }
  if (isVerifyExpired(row)) {
    await closeUnverifiedDemo(admin, row.id, 'verify_expired');
    return json(
      {
        error: 'Die Anfrage ist abgelaufen. Bitte fordere die Demo erneut an.',
        code: 'expired',
      },
      410
    );
  }
  if (row.verify_sends >= DEMO_CODE_MAX_SENDS) {
    return json(
      {
        error:
          'Es wurden bereits mehrere Codes gesendet. Bitte prüf deine Nachrichten oder fordere die Demo später erneut an.',
        code: 'resend_limit',
      },
      429
    );
  }
  const sinceLast = row.verify_last_sent_at
    ? (Date.now() - Date.parse(row.verify_last_sent_at)) / 1000
    : Number.POSITIVE_INFINITY;
  if (sinceLast < DEMO_CODE_RESEND_COOLDOWN_SECONDS) {
    const retryAfter = Math.ceil(DEMO_CODE_RESEND_COOLDOWN_SECONDS - sinceLast);
    return json(
      {
        error: `Bitte warte noch ${retryAfter} Sekunden, bevor du einen neuen Code anforderst.`,
        code: 'cooldown',
        retryAfterSeconds: retryAfter,
      },
      429
    );
  }

  // Landlines cannot receive SMS — they always get the voice call.
  const wanted = isGermanMobile(row.phone_e164) ? (parsed.data.channel ?? 'sms') : 'call';

  // Claim the send slot first (parallel clicks race for it).
  const { data: claimed, error: claimError } = await admin
    .from('demo_calls')
    .update({
      verify_sends: row.verify_sends + 1,
      verify_last_sent_at: new Date().toISOString(),
      verify_channel: wanted,
    })
    .eq('id', row.id)
    .eq('status', 'awaiting_confirmation')
    .eq('verify_sends', row.verify_sends)
    .select('id');
  if (claimError) return json(UNAVAILABLE, 503);
  if (!claimed || claimed.length === 0) {
    return json({ error: 'Bitte versuch es erneut.', code: 'retry' }, 409);
  }

  const sent = await sendDemoCode(row.phone_e164, wanted);
  if (!sent.ok) {
    log.warn({ demoCallId: row.id, reason: sent.reason }, 'demo verification resend failed');
    const failure = DEMO_SEND_FAILURES[sent.reason];
    return json({ error: failure.error, code: failure.code }, failure.status);
  }
  if (sent.channel !== wanted) {
    await admin.from('demo_calls').update({ verify_channel: sent.channel }).eq('id', row.id);
  }
  return json(
    {
      ok: true,
      channel: sent.channel,
      resendAfterSeconds: DEMO_CODE_RESEND_COOLDOWN_SECONDS,
      sendsLeft: DEMO_CODE_MAX_SENDS - (row.verify_sends + 1),
    },
    200
  );
}
