import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@zendori/core';
import type { SupabaseClient } from '@zendori/core';
import {
  formSubmissionValuesSchema,
  roleValue,
  serializeSubmission,
  submissionSnapshot,
  validateSubmission,
  verifyRenderToken,
} from '@zendori/channels';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { corsHeaders, preflight } from '@/lib/widget/cors';
import { findActiveFormByToken, FormDbError, type ActiveForm } from '@/lib/forms/lookup';

// Public form submission (Phase 10). Fast, stateless, strictly gated: rate
// limits → honeypot → HMAC render token (min-time) → server-side validation
// against the stored definition → daily cap → persist as a normal
// conversation/message (processing_state 'pending' → worker pipeline).
// Contact data comes DIRECTLY from the role fields (no AI hop) and is marked
// contact_authoritative so extraction never overwrites exact user input.
// No form content in logs (§7).

export const runtime = 'nodejs';

const log = createLogger('form-submit');

const bodySchema = z.object({
  token: z.string().regex(/^[0-9a-f]{32}$/),
  clientSubmissionId: z.uuid(),
  renderToken: z.string().max(200),
  values: formSubmissionValuesSchema,
  /** Honeypot — humans never see it, so it MUST be empty. */
  website: z.string().max(200).optional(),
});

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders() });
}

export function OPTIONS(): Response {
  return preflight();
}

/** Find-or-create a contact from the role fields. Never overwrites an existing contact. */
async function resolveFormContact(
  admin: SupabaseClient,
  params: { orgId: string; email: string | null; name: string | null; phone: string | null }
): Promise<{ id: string; created: boolean } | null> {
  const { orgId, email, name, phone } = params;
  const normalizedEmail = email?.trim().toLowerCase() ?? null;

  if (normalizedEmail) {
    const { data: rows, error } = await admin
      .from('contacts')
      .select('id')
      .eq('org_id', orgId)
      .eq('email', normalizedEmail)
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) return null;
    const existing = (rows ?? [])[0] as { id: string } | undefined;
    // deliberate: no name/phone overwrite on an existing contact — a public
    // endpoint must not be able to poison known contacts (concept §3.1c)
    if (existing) return { id: existing.id, created: false };
  }

  const { data: inserted, error: insertError } = await admin
    .from('contacts')
    .insert({ org_id: orgId, name, email: normalizedEmail, phone })
    .select('id')
    .single();
  if (insertError || !inserted) return null;
  return { id: (inserted as { id: string }).id, created: true };
}

/**
 * True when today's (UTC) submission count reached the form's cap. Only real
 * builder submissions count (external_id 'form-…') — e-mail replies of
 * submitters thread into the same channel via its intake address and must not
 * deplete the "Tageslimit für Einsendungen".
 */
async function dailyCapReached(admin: SupabaseClient, form: ActiveForm): Promise<boolean> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count, error } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('channel_id', form.channelId)
    .eq('direction', 'in')
    .like('external_id', 'form-%')
    .gte('created_at', startOfDay.toISOString());
  if (error) return false; // fail-open like the rate limiter — never lose real leads
  return (count ?? 0) >= form.dailySubmissionLimit;
}

export async function POST(request: Request): Promise<NextResponse> {
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
  const { token, clientSubmissionId, renderToken, values, website } = parsed.data;

  const [ipAllowed, tokenAllowed] = await Promise.all([
    checkRateLimit('form-submit-ip', clientIp(request)),
    checkRateLimit('form-submit-token', token),
  ]);
  if (!ipAllowed || !tokenAllowed) {
    return json({ error: 'Zu viele Anfragen. Bitte versuchen Sie es gleich erneut.' }, 429);
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
    form = await findActiveFormByToken(admin, token);
  } catch (error) {
    if (error instanceof FormDbError) {
      return json({ error: 'Dienst vorübergehend nicht verfügbar.' }, 503);
    }
    throw error;
  }
  if (!form) {
    return json({ error: 'Formular wurde nicht gefunden.' }, 404);
  }

  // Honeypot: silently accept and drop — bots get no signal (metadata-only log).
  if (website !== undefined && website.length > 0) {
    log.info({ formId: form.id }, 'honeypot submission dropped');
    return json({ ok: true }, 200);
  }

  // Render-token gate: HMAC + min-time (3 s) + max-age (24 h). The embed
  // re-bootstraps transparently on this error code and retries.
  const verdict = verifyRenderToken(masterKey, token, renderToken);
  if (verdict !== 'ok') {
    return json({ error: 'render_token', code: 'render_token' }, 400);
  }

  const validated = validateSubmission(form.definition, values);
  if (!validated.ok) {
    return json({ error: 'Bitte Eingaben prüfen.' }, 400);
  }

  if (await dailyCapReached(admin, form)) {
    log.warn({ formId: form.id }, 'daily submission cap reached');
    return json({ error: 'Zu viele Anfragen. Bitte versuchen Sie es später erneut.' }, 429);
  }

  const email = roleValue(form.definition, validated.values, 'email');
  const name = roleValue(form.definition, validated.values, 'name');
  const phone = roleValue(form.definition, validated.values, 'phone');
  const subject = roleValue(form.definition, validated.values, 'subject') ?? form.name;

  const contact = await resolveFormContact(admin, {
    orgId: form.orgId,
    email,
    name,
    phone,
  });
  if (!contact) {
    log.error({ formId: form.id }, 'could not resolve contact');
    return json({ error: 'Einsendung konnte nicht gespeichert werden.' }, 500);
  }
  const contactId = contact.id;
  // roll back a contact WE created when the submission does not stick — retried
  // e-mail-less submissions must not accumulate orphan contact rows
  const rollbackContact = async (): Promise<void> => {
    if (contact.created) {
      await admin.from('contacts').delete().eq('id', contactId).eq('org_id', form.orgId);
    }
  };

  // One NEW conversation per submission (forms are one-shot requests; e-mail
  // replies of the submitter thread in via the Resend hook later).
  const { data: convo, error: convoError } = await admin
    .from('conversations')
    .insert({
      org_id: form.orgId,
      channel_id: form.channelId,
      contact_id: contactId,
      subject,
      status: 'open',
      mode: 'bot',
    })
    .select('id')
    .single();
  if (convoError || !convo) {
    await rollbackContact();
    log.error({ formId: form.id }, 'could not create conversation');
    return json({ error: 'Einsendung konnte nicht gespeichert werden.' }, 500);
  }
  const conversationId = (convo as { id: string }).id;

  const { data: inserted, error: messageError } = await admin
    .from('messages')
    .insert({
      org_id: form.orgId,
      conversation_id: conversationId,
      channel_id: form.channelId,
      direction: 'in',
      sender_type: 'contact',
      content: serializeSubmission(form.definition, validated.values),
      content_type: 'text',
      external_id: `form-${clientSubmissionId}`,
      metadata: {
        form: submissionSnapshot({
          formId: form.id,
          version: form.version,
          definition: form.definition,
          values: validated.values,
          now: new Date(),
        }),
      },
      processing_state: 'pending',
    })
    .select('id')
    .single();
  if (messageError) {
    // idempotency: a retried submit must not create a duplicate — roll back
    // the conversation + own contact we just created (Resend-route pattern)
    await admin.from('conversations').delete().eq('id', conversationId).eq('org_id', form.orgId);
    await rollbackContact();
    if (messageError.code === '23505') {
      return json({ ok: true, deduped: true, successMessage: form.definition.design.successMessage }, 200);
    }
    log.error({ formId: form.id }, 'could not persist message');
    return json({ error: 'Einsendung konnte nicht gespeichert werden.' }, 500);
  }
  const messageId = (inserted as { id: string }).id;

  // Forwarding queue (best-effort: a failed queue row must not fail the
  // submission — the worker sweep only sees persisted rows).
  if (form.notificationEmails.length > 0) {
    const { error: notifyError } = await admin.from('form_notifications').insert({
      org_id: form.orgId,
      form_id: form.id,
      message_id: messageId,
      recipients: form.notificationEmails,
    });
    if (notifyError) {
      log.error({ formId: form.id }, 'could not enqueue notification');
    }
  }

  return json({ ok: true, successMessage: form.definition.design.successMessage }, 200);
}
