import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger, DEMO_CODE_MAX_ATTEMPTS, toPublicDemoStatus } from '@zendori/core';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { corsHeaders, preflight } from '@/lib/widget/cors';
import {
  checkDemoCaps,
  closeUnverifiedDemo,
  DEMO_CAP_MESSAGES,
  DEMO_TOKEN_PATTERN,
  isVerifyExpired,
  loadDemoByStatusToken,
} from '@/lib/demo/server';
import { checkDemoCode } from '@/lib/demo/verify';

// Demo phone verification (0032): the visitor types the SMS/voice code into
// the embed. Correct code → re-check the call caps → 'queued' (the DB trigger
// wakes the worker, which dials). Attempts are counted here (optimistic
// conditional update) on top of Twilio's own per-code limit. Idempotent: a
// request that is already past verification just reports its status.

export const runtime = 'nodejs';
export const maxDuration = 15;

const log = createLogger('demo-verify');

const bodySchema = z.object({
  token: z.string().regex(DEMO_TOKEN_PATTERN),
  code: z
    .string()
    .max(20)
    .transform((value) => value.replace(/\s+/g, ''))
    .pipe(z.string().regex(/^\d{4,10}$/)),
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
  error: 'Der Dienst ist vorübergehend nicht verfügbar. Bitte versuchen Sie es gleich erneut.',
  code: 'unavailable',
};
const CLOSED = {
  error: 'Zu viele Fehlversuche. Bitte fordern Sie die Demo erneut an.',
  code: 'too_many_attempts',
};
const EXPIRED = {
  error: 'Die Anfrage ist abgelaufen. Bitte fordern Sie die Demo erneut an.',
  code: 'expired',
};

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await checkRateLimit('demo-verify-ip', clientIp(request)))) {
    return json(
      { error: 'Zu viele Versuche. Bitte warten Sie einen Moment.', code: 'rate_limited' },
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
  if (!parsed.success) {
    return json({ error: 'Bitte geben Sie den Code aus der SMS ein.', code: 'invalid_code' }, 400);
  }
  const { token, code } = parsed.data;

  let admin;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    admin = null;
  }
  if (!admin) return json(UNAVAILABLE, 503);

  const { row, error } = await loadDemoByStatusToken(admin, token);
  if (error) return json(UNAVAILABLE, 503);
  if (!row) return json({ error: 'Nicht gefunden.', code: 'not_found' }, 404);

  // Already verified (double submit) or closed: report, never re-check.
  if (row.status !== 'awaiting_confirmation') {
    return json({ ok: true, status: toPublicDemoStatus(row.status) }, 200);
  }
  if (isVerifyExpired(row)) {
    await closeUnverifiedDemo(admin, row.id, 'verify_expired');
    return json(EXPIRED, 410);
  }
  if (row.verify_attempts >= DEMO_CODE_MAX_ATTEMPTS) {
    await closeUnverifiedDemo(admin, row.id, 'too_many_attempts');
    return json(CLOSED, 429);
  }

  // Count the attempt BEFORE asking Twilio; the conditional update makes two
  // parallel attempts race for the same slot instead of both passing.
  const { data: counted, error: countError } = await admin
    .from('demo_calls')
    .update({ verify_attempts: row.verify_attempts + 1 })
    .eq('id', row.id)
    .eq('status', 'awaiting_confirmation')
    .eq('verify_attempts', row.verify_attempts)
    .select('id');
  if (countError) return json(UNAVAILABLE, 503);
  if (!counted || counted.length === 0) {
    return json({ error: 'Bitte versuchen Sie es erneut.', code: 'retry' }, 409);
  }
  const remaining = DEMO_CODE_MAX_ATTEMPTS - (row.verify_attempts + 1);

  const result = await checkDemoCode(row.phone_e164, code);
  switch (result) {
    case 'wrong_code':
      if (remaining <= 0) {
        await closeUnverifiedDemo(admin, row.id, 'too_many_attempts');
        return json(CLOSED, 429);
      }
      return json(
        {
          error:
            remaining === 1
              ? 'Der Code stimmt nicht. Sie haben noch einen Versuch.'
              : `Der Code stimmt nicht. Sie haben noch ${remaining} Versuche.`,
          code: 'wrong_code',
        },
        400
      );
    case 'code_expired':
      return json(
        {
          error: 'Dieser Code ist nicht mehr gültig. Bitte fordern Sie einen neuen Code an.',
          code: 'code_expired',
        },
        400
      );
    case 'max_attempts':
      await closeUnverifiedDemo(admin, row.id, 'too_many_attempts');
      return json(CLOSED, 429);
    case 'unavailable':
      log.warn({ demoCallId: row.id }, 'demo verification check unavailable');
      return json(UNAVAILABLE, 503);
    case 'approved':
      break;
  }

  // Verified. The call caps may have filled up meanwhile (another request for
  // the same number, the global day cap) — fail-closed.
  const caps = await checkDemoCaps(admin, row.phone_e164, { stage: 'verified' });
  if (caps === 'db_error') return json(UNAVAILABLE, 503);
  if (caps !== 'ok') {
    await closeUnverifiedDemo(admin, row.id, caps);
    return json({ error: DEMO_CAP_MESSAGES[caps], code: caps }, 429);
  }

  const { data: queued, error: queueError } = await admin
    .from('demo_calls')
    .update({ status: 'queued', confirmed_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', 'awaiting_confirmation')
    .select('status');
  if (queueError) return json(UNAVAILABLE, 503);
  if (!queued || queued.length === 0) {
    // a parallel verify won — report whatever it set
    const { row: current } = await loadDemoByStatusToken(admin, token);
    return json({ ok: true, status: current ? toPublicDemoStatus(current.status) : 'queued' }, 200);
  }

  log.info({ demoCallId: row.id }, 'demo phone verified, call queued');
  return json({ ok: true, status: 'queued' }, 200);
}
