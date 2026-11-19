import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  CONTACT_CONSENT_VERSION,
  CONTACT_RENDER_SCOPE,
  contactInputSchema,
  createLogger,
  validateContactRequest,
} from '@zendori/core';
import { verifyRenderToken } from '@zendori/channels';
import { hashContactIp, sendContactNotification } from '@/lib/contact/server';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { corsHeaders, preflight } from '@/lib/widget/cors';

// Public contact form submit (Kontaktanfragen, 0034): rate limits → honeypot →
// HMAC render token (min-time) → validation → persist (idempotent on
// clientRequestId) → notification mail to the operator inbox. The request is
// stored FIRST: a failed mail never loses it (the admin list marks it). No
// request content in logs (§7).

export const runtime = 'nodejs';
export const maxDuration = 20;

const log = createLogger('contact-submit');

const bodySchema = contactInputSchema.extend({
  renderToken: z.string().max(200),
  clientRequestId: z.uuid(),
  consent: z.boolean().optional(),
  /** Honeypot — humans never see it, so it MUST be empty. */
  nickname: z.string().max(200).optional(),
});

const UNAVAILABLE = {
  error: 'Der Dienst ist vorübergehend nicht verfügbar. Bitte versuch es gleich erneut.',
  code: 'unavailable',
};

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders() });
}

export function OPTIONS(): Response {
  return preflight();
}

export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientIp(request);
  if (!(await checkRateLimit('contact-submit-ip', ip))) {
    return json(
      {
        error: 'Zu viele Nachrichten von deinem Anschluss. Bitte versuch es später erneut.',
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
  if (!masterKey) return json(UNAVAILABLE, 503);

  // Honeypot hit: pretend success, store and send nothing.
  if (body.nickname && body.nickname.trim().length > 0) {
    return json({ ok: true }, 200);
  }

  const verdict = verifyRenderToken(masterKey, CONTACT_RENDER_SCOPE, body.renderToken);
  if (verdict === 'expired' || verdict === 'invalid') {
    return json({ error: 'Bitte sende das Formular erneut ab.', code: 'render_expired' }, 400);
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

  const validation = validateContactRequest(body);
  const fields: Record<string, string> = validation.ok ? {} : { ...validation.errors };
  if (body.consent !== true) {
    fields.consent = 'Bitte stimme der Verarbeitung deiner Angaben zu.';
  }
  if (!validation.ok || Object.keys(fields).length > 0) {
    return json({ error: 'Bitte prüf deine Eingaben.', code: 'invalid', fields }, 400);
  }
  const data = validation.data;

  if (!(await checkRateLimit('contact-submit-email', data.email))) {
    return json(
      {
        error: 'Von dieser E-Mail-Adresse sind heute schon mehrere Nachrichten eingegangen. Wir melden uns.',
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

  const createdAt = new Date().toISOString();
  const { data: inserted, error: insertError } = await admin
    .from('contact_requests')
    .insert({
      created_at: createdAt,
      name: data.name,
      email: data.email,
      company: data.company,
      phone: data.phone,
      topic: data.topic,
      message: data.message,
      consent_at: createdAt,
      consent_version: CONTACT_CONSENT_VERSION,
      client_request_id: body.clientRequestId,
      ip_hash: hashContactIp(ip),
    })
    .select('id')
    .single();
  if (insertError || !inserted) {
    // Idempotency: a retried submit of the same filled form (double click,
    // flaky network) is the same request — success, no second row, no second mail.
    if (insertError?.code === '23505') return json({ ok: true }, 200);
    log.error({ code: insertError?.code ?? null }, 'contact request insert failed');
    return json(UNAVAILABLE, 503);
  }
  const requestId = (inserted as { id: string }).id;

  try {
    await sendContactNotification({ request: data, createdAt, requestId });
    await admin
      .from('contact_requests')
      .update({ notified_at: new Date().toISOString() })
      .eq('id', requestId);
  } catch (err) {
    // the request is stored and visible in the admin list (marked "Mail nicht gesendet")
    log.warn(
      { requestId, err: err instanceof Error ? err.message : 'unknown' },
      'contact notification mail failed'
    );
  }

  return json({ ok: true }, 200);
}
