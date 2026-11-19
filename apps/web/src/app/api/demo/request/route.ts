import { createHmac } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createLogger,
  DEMO_CONSENT_VERSION,
  DEMO_RENDER_SCOPE,
  DEMO_VERIFY_TTL_MS,
  demoLeadInputSchema,
  demoVerifyChannelFor,
  maskDemoPhone,
  validateDemoLead,
} from '@zendori/core';
import { verifyRenderToken } from '@zendori/channels';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { corsHeaders, preflight } from '@/lib/widget/cors';
import {
  checkDemoCaps,
  DEMO_CAP_MESSAGES,
  DEMO_SEND_FAILURES,
  hashDemoIp,
  hashDemoToken,
  newDemoToken,
} from '@/lib/demo/server';
import { isDemoVerifyConfigured, sendDemoCode } from '@/lib/demo/verify';

// Public demo request (Demo-Anruf, 0032). Fast and strictly gated:
// rate limits → honeypot → HMAC render token (min-time) → validation (German
// numbers only, no service ranges) → fail-closed DB caps → persist as
// 'awaiting_confirmation' → verification code to the entered number (SMS for
// mobile, voice call for landline — Twilio Verify). Nothing is dialed here:
// the call only starts once the code was entered (/api/demo/verify) and is
// driven by the worker. Verifying the NUMBER (not an e-mail) is the point —
// only whoever holds the phone can make the assistant call it. No lead data
// in logs (§7).

export const runtime = 'nodejs';
export const maxDuration = 20;

const log = createLogger('demo-request');

const bodySchema = demoLeadInputSchema.extend({
  renderToken: z.string().max(200),
  clientRequestId: z.uuid(),
  consent: z.boolean().optional(),
  /** Honeypot — humans never see it, so it MUST be empty. */
  nickname: z.string().max(200).optional(),
});

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders() });
}

export function OPTIONS(): Response {
  return preflight();
}

const UNAVAILABLE = {
  error: 'Der Dienst ist vorübergehend nicht verfügbar. Bitte versuch es gleich erneut.',
  code: 'unavailable',
};

/**
 * The status token is derived from the client's request id (HMAC with the
 * master key): a network retry of the SAME submission gets the same token
 * back without a second row or a second mail.
 */
function statusTokenFor(masterKey: string, clientRequestId: string): string {
  return createHmac('sha256', Buffer.from(masterKey, 'base64'))
    .update(`demo-status:${clientRequestId}`)
    .digest('hex');
}

export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientIp(request);
  if (!(await checkRateLimit('demo-request-ip', ip))) {
    return json(
      {
        error: 'Zu viele Anfragen von deinem Anschluss. Bitte versuch es später erneut.',
        code: 'rate_limited',
      },
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
    return json({ error: 'Ungültige Anfrage.', code: 'invalid' }, 400);
  }
  const body = parsed.data;

  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  if (!masterKey || !isDemoVerifyConfigured()) return json(UNAVAILABLE, 503);

  // Honeypot hit: pretend success, store and send nothing.
  if (body.nickname && body.nickname.trim().length > 0) {
    return json({ ok: true, statusToken: newDemoToken(), channel: 'sms', phone: '••••' }, 200);
  }

  const verdict = verifyRenderToken(masterKey, DEMO_RENDER_SCOPE, body.renderToken);
  if (verdict === 'expired') {
    return json(
      { error: 'Bitte sende das Formular erneut ab.', code: 'render_expired' },
      400
    );
  }
  if (verdict === 'too_fast') {
    return json(
      {
        error: 'Bitte warte einen kurzen Moment und sende das Formular dann erneut ab.',
        code: 'too_fast',
      },
      400
    );
  }
  if (verdict !== 'ok') {
    return json({ error: 'Ungültige Anfrage.', code: 'invalid' }, 400);
  }

  const validation = validateDemoLead(body, { requireEmail: true });
  const fields: Record<string, string> = validation.ok ? {} : { ...validation.errors };
  if (body.consent !== true) {
    fields.consent = 'Bitte stimme dem Demo-Anruf zu.';
  }
  if (!validation.ok || Object.keys(fields).length > 0) {
    return json({ error: 'Bitte prüf deine Eingaben.', code: 'invalid', fields }, 400);
  }
  const lead = validation.lead;
  const email = lead.email as string; // requireEmail: true

  if (!(await checkRateLimit('demo-request-email', email))) {
    return json(
      {
        error: 'Für diese E-Mail-Adresse wurden heute schon Demos angefordert. Bitte versuch es morgen erneut.',
        code: 'rate_limited',
      },
      429
    );
  }

  let admin;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    admin = null;
  }
  if (!admin) return json(UNAVAILABLE, 503);

  const statusToken = statusTokenFor(masterKey, body.clientRequestId);

  // Idempotency: a retried submission returns the original status token and
  // sends no second code.
  const { data: existing, error: existingError } = await admin
    .from('demo_calls')
    .select('phone_e164, verify_channel')
    .eq('client_request_id', body.clientRequestId)
    .maybeSingle();
  if (existingError) return json(UNAVAILABLE, 503);
  if (existing) {
    const row = existing as { phone_e164: string; verify_channel: string | null };
    return json(
      {
        ok: true,
        statusToken,
        channel: row.verify_channel ?? demoVerifyChannelFor(row.phone_e164),
        phone: maskDemoPhone(row.phone_e164),
      },
      200
    );
  }

  const caps = await checkDemoCaps(admin, lead.phoneE164, { stage: 'request' });
  if (caps === 'db_error') return json(UNAVAILABLE, 503);
  if (caps !== 'ok') {
    return json({ error: DEMO_CAP_MESSAGES[caps], code: caps }, 429);
  }

  const now = Date.now();
  const { data: inserted, error: insertError } = await admin
    .from('demo_calls')
    .insert({
      source: 'public',
      company_name: lead.company,
      contact_name: lead.contactName,
      email,
      phone_e164: lead.phoneE164,
      website_url: lead.websiteUrl,
      prompt: lead.prompt,
      consent_at: new Date(now).toISOString(),
      consent_version: DEMO_CONSENT_VERSION,
      verify_expires_at: new Date(now + DEMO_VERIFY_TTL_MS).toISOString(),
      status_token_hash: hashDemoToken(statusToken),
      client_request_id: body.clientRequestId,
      ip_hash: hashDemoIp(ip),
      status: 'awaiting_confirmation',
    })
    .select('id')
    .single();
  if (insertError || !inserted) {
    if (insertError?.code === '23505') {
      // lost the idempotency race against a parallel retry of this submission
      // (that one sends the code)
      return json(
        {
          ok: true,
          statusToken,
          channel: demoVerifyChannelFor(lead.phoneE164),
          phone: maskDemoPhone(lead.phoneE164),
        },
        200
      );
    }
    log.error({ code: insertError?.code ?? null }, 'demo request insert failed');
    return json(UNAVAILABLE, 503);
  }
  const demoCallId = (inserted as { id: string }).id;

  const sent = await sendDemoCode(lead.phoneE164, demoVerifyChannelFor(lead.phoneE164));
  if (!sent.ok) {
    // Without a code the request can never be verified — roll it back so the
    // visitor can correct the number or simply submit again.
    await admin.from('demo_calls').delete().eq('id', demoCallId);
    log.warn({ demoCallId, reason: sent.reason }, 'demo verification code not sent');
    const failure = DEMO_SEND_FAILURES[sent.reason];
    return json(
      {
        error: failure.error,
        code: failure.code,
        ...(failure.phoneField ? { fields: { phone: failure.error } } : {}),
      },
      failure.status
    );
  }

  const { error: sentUpdateError } = await admin
    .from('demo_calls')
    .update({
      verify_channel: sent.channel,
      verify_sends: 1,
      verify_last_sent_at: new Date().toISOString(),
    })
    .eq('id', demoCallId);
  if (sentUpdateError) {
    // the code is on its way; the counters only gate resends — not fatal
    log.warn({ demoCallId, code: sentUpdateError.code }, 'demo verify bookkeeping failed');
  }

  log.info({ demoCallId, channel: sent.channel }, 'demo request accepted, code sent');
  return json(
    { ok: true, statusToken, channel: sent.channel, phone: maskDemoPhone(lead.phoneE164) },
    200
  );
}
