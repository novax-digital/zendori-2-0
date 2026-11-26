import { NextResponse } from 'next/server';
import { createLogger, isMissingRelationError } from '@zendori/core';
import type { SupabaseClient } from '@zendori/core';
import {
  StripeSignatureError,
  stripeEventRef,
  stripeEventSchema,
  stripeEventScope,
  verifyStripeSignature,
} from '@zendori/integrations';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { stripeRuntime, stripeWebhookSecrets } from '@/lib/stripe';

// Stripe webhook (Phase 15). Verifies the signature on the raw body and stores
// the event as ONE content-free row in stripe_events: its id and the ids it
// points at, never the payload. Nothing is processed here — the worker picks
// the row up and reads the current object from Stripe (events carry no ordering
// guarantee, and web does nothing that could fail half-way, §4/§12).
//
// Idempotency: the event id is the primary key. A redelivery hits 23505 and is
// acknowledged. A non-2xx answer makes Stripe retry (for up to three days in
// live mode), so "not configured" and "table missing" answer 503 on purpose.
export const runtime = 'nodejs';
export const maxDuration = 15;

const log = createLogger('stripe-webhook');

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();

  const secrets = stripeWebhookSecrets();
  if (secrets.length === 0) return json({ error: 'stripe webhook not configured' }, 503);

  try {
    verifyStripeSignature(rawBody, request.headers.get('stripe-signature'), secrets);
  } catch (error) {
    const reason = error instanceof StripeSignatureError ? error.reason : 'unknown';
    log.warn({ reason }, 'stripe webhook signature rejected');
    return json({ error: 'invalid signature' }, 400);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid payload' }, 400);
  }
  const parsed = stripeEventSchema.safeParse(payload);
  if (!parsed.success) return json({ error: 'invalid payload' }, 400);
  const event = parsed.data;

  // Events Zendori does not act on are acknowledged without a row.
  if (stripeEventScope(event.type) === null) return json({ ok: true, ignored: true }, 200);

  let admin: SupabaseClient | null;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return json({ error: 'service unavailable' }, 503);
  }
  if (!admin) return json({ error: 'service unavailable' }, 503);

  const ref = stripeEventRef(event);
  // An event of the other mode (test event while running on a live key, or the
  // reverse) is kept as a trace but never worked on.
  const mode = stripeRuntime()?.livemode ?? null;
  const state = mode !== null && mode !== ref.livemode ? 'skipped' : 'pending';

  const { error } = await admin.from('stripe_events').insert({
    event_id: ref.eventId,
    type: ref.type,
    livemode: ref.livemode,
    object_type: ref.objectType,
    object_id: ref.objectId,
    customer_id: ref.customerId,
    state,
    ...(state === 'skipped' ? { last_error: 'other_mode' } : {}),
  });
  if (error) {
    if (error.code === '23505') return json({ ok: true, deduped: true }, 200);
    if (isMissingRelationError(error)) {
      // migration 0041 not applied yet — Stripe delivers again later
      return json({ error: 'service unavailable' }, 503);
    }
    log.error({ eventType: ref.type, code: error.code }, 'could not store stripe event');
    return json({ error: 'persist failed' }, 500);
  }

  log.info({ eventType: ref.type, livemode: ref.livemode, state }, 'stripe event stored');
  return json({ ok: true }, 200);
}
