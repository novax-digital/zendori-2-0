import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createLogger,
  StandardWebhookVerificationError,
  verifyStandardWebhook,
} from '@zendori/core';
import type { SupabaseClient } from '@zendori/core';
import { xaiCallIncomingEventSchema, xaiEventTypePeekSchema } from '@zendori/channels';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

// xAI voice webhook for the operator DEMO number (Demo-Anruf, 0032). The demo
// call is OUTBOUND: the worker has Twilio dial the lead, and when the lead
// answers, Twilio bridges via <Dial><Sip> to the demo number at xAI — which
// xAI sees as an incoming call and announces here. We match it to the
// 'dialing' demo row (primary: the X-Zendori-Demo SIP header the worker
// stamped into the SIP URI; fallback: the single dialing row), store the xAI
// call_id and flip the row to 'connecting'. The 0032 trigger broadcasts that
// so the worker joins the call WebSocket immediately — the lead is already on
// the line. Verified with the demo number's own signing secret (env, not
// channels.config: the demo number belongs to no org). No long work here.

export const runtime = 'nodejs';
export const maxDuration = 15;

const log = createLogger('demo-voice-hook');

/** A dialing row older than this cannot be the call being announced. */
const DIALING_MATCH_WINDOW_MS = 3 * 60 * 1000;

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

/** Atomic dialing → connecting transition; returns true when this request won. */
async function claimDialing(
  admin: SupabaseClient,
  demoCallId: string,
  providerCallId: string
): Promise<'claimed' | 'not_dialing' | 'duplicate' | 'error'> {
  const { data, error } = await admin
    .from('demo_calls')
    .update({ status: 'connecting', provider_call_id: providerCallId })
    .eq('id', demoCallId)
    .eq('status', 'dialing')
    .select('id');
  if (error) return error.code === '23505' ? 'duplicate' : 'error';
  return (data ?? []).length > 0 ? 'claimed' : 'not_dialing';
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();

  const secret = process.env.DEMO_XAI_SIGNING_SECRET;
  if (!secret) {
    log.error('DEMO_XAI_SIGNING_SECRET not configured');
    return json({ error: 'service unavailable' }, 503);
  }
  try {
    verifyStandardWebhook(
      rawBody,
      {
        id: request.headers.get('webhook-id'),
        timestamp: request.headers.get('webhook-timestamp'),
        signature: request.headers.get('webhook-signature'),
      },
      secret
    );
  } catch (error) {
    if (!(error instanceof StandardWebhookVerificationError)) {
      log.error('demo voice webhook verification crashed');
    }
    return json({ error: 'invalid signature' }, 401);
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid payload' }, 400);
  }
  const peek = xaiEventTypePeekSchema.safeParse(event);
  if (!peek.success) return json({ error: 'invalid payload' }, 400);
  if (peek.data.type !== 'realtime.call.incoming') {
    return json({ ok: true, ignored: true }, 200);
  }
  const parsed = xaiCallIncomingEventSchema.safeParse(event);
  if (!parsed.success) {
    log.warn('demo call.incoming payload did not match schema');
    return json({ error: 'invalid payload' }, 400);
  }
  const callId = parsed.data.data.call_id;
  const headerValue =
    parsed.data.data.sip_headers.find((h) => h.name.toLowerCase() === 'x-zendori-demo')?.value ??
    null;
  const headerId = headerValue && z.uuid().safeParse(headerValue.trim()).success
    ? headerValue.trim()
    : null;

  let admin: SupabaseClient | null;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    admin = null;
  }
  if (!admin) return json({ error: 'service unavailable' }, 503);

  // Idempotency: a redelivered call_id was already matched.
  const { data: known, error: knownError } = await admin
    .from('demo_calls')
    .select('id')
    .eq('provider_call_id', callId)
    .maybeSingle();
  if (knownError) return json({ error: 'service unavailable' }, 503);
  if (known) return json({ ok: true, deduped: true }, 200);

  let demoCallId = headerId;
  if (!demoCallId) {
    // Live-gate fallback: xAI may not pass custom SIP headers through. With a
    // low concurrency cap there is normally exactly one dialing demo — take it
    // only when unambiguous, never guess between several.
    const since = new Date(Date.now() - DIALING_MATCH_WINDOW_MS).toISOString();
    const { data: dialing, error: dialingError } = await admin
      .from('demo_calls')
      .select('id')
      .eq('status', 'dialing')
      .gte('dialed_at', since)
      .limit(2);
    if (dialingError) return json({ error: 'service unavailable' }, 503);
    const rows = (dialing ?? []) as { id: string }[];
    if (rows.length !== 1) {
      log.warn({ candidates: rows.length }, 'demo call without X-Zendori-Demo header — unmatched');
      return json({ ok: true, ignored: true }, 200);
    }
    demoCallId = rows[0]!.id;
    log.info({ demoCallId }, 'demo call matched via single-dialing fallback');
  }

  const outcome = await claimDialing(admin, demoCallId, callId);
  switch (outcome) {
    case 'claimed':
      log.info({ demoCallId }, 'demo call connecting');
      return json({ ok: true }, 200);
    case 'duplicate':
      return json({ ok: true, deduped: true }, 200);
    case 'not_dialing':
      // Inbound call to the demo number, a cancelled demo, or a late retry.
      log.info({ demoCallId }, 'demo call not in dialing state — ignored');
      return json({ ok: true, ignored: true }, 200);
    default:
      return json({ error: 'service unavailable' }, 503);
  }
}
