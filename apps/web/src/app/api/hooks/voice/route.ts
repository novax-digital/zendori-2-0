import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createLogger,
  decryptSecret,
  verifyStandardWebhook,
  StandardWebhookVerificationError,
} from '@zendori/core';
import type { SupabaseClient } from '@zendori/core';
import {
  sipHeaderNumber,
  voiceChannelConfigSchema,
  xaiCallIncomingEventSchema,
  xaiEventTypePeekSchema,
} from '@zendori/channels';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

// xAI voice webhook (Phase 9). On an incoming SIP call xAI POSTs a signed
// realtime.call.incoming event (Standard Webhooks scheme). We route by the
// ?channel= query param stamped into the webhook URL at number registration,
// cross-check the To number, verify the signature with the channel's decrypted
// dispatch signing secret, then persist contact + conversation + voice_calls
// row and return fast. The voice_calls insert fires the 0009 broadcast trigger
// that wakes the worker (which joins the call's WebSocket). No long work here.
export const runtime = 'nodejs';
export const maxDuration = 30;

const log = createLogger('voice-ingest');

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

function masterKey(): string | null {
  const key = process.env.MASTER_ENCRYPTION_KEY;
  return key && key.length > 0 ? key : null;
}

/**
 * Resolves (find-or-create) the caller contact by phone within the org. Returns
 * whether the contact was freshly created so rollback paths can remove it again
 * (a lost idempotency race must not accumulate orphaned contacts).
 */
async function resolveVoiceContact(
  admin: SupabaseClient,
  params: { orgId: string; phone: string | null }
): Promise<{ id: string; created: boolean } | null> {
  const { orgId, phone } = params;
  if (phone) {
    const { data: rows } = await admin
      .from('contacts')
      .select('id')
      .eq('org_id', orgId)
      .eq('phone', phone)
      .order('created_at', { ascending: true })
      .limit(1);
    const existing = (rows ?? [])[0] as { id: string } | undefined;
    if (existing) return { id: existing.id, created: false };
  }
  const { data: created, error } = await admin
    .from('contacts')
    .insert({ org_id: orgId, phone })
    .select('id')
    .single();
  if (error || !created) return null;
  return { id: (created as { id: string }).id, created: true };
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();

  // 1. Channel lookup via the ?channel= param stamped into the registered URL.
  const channelId = new URL(request.url).searchParams.get('channel');
  if (!channelId || !z.uuid().safeParse(channelId).success) {
    return json({ ok: true, ignored: true }, 200);
  }

  let admin: SupabaseClient | null;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return json({ error: 'service unavailable' }, 503);
  }
  if (!admin) return json({ error: 'service unavailable' }, 503);

  const { data: channelRow } = await admin
    .from('channels')
    .select('id, org_id, config')
    .eq('id', channelId)
    .eq('type', 'voice')
    .eq('is_active', true)
    .maybeSingle();
  const channel = channelRow as { id: string; org_id: string; config: unknown } | null;
  if (!channel) {
    log.info({ channelId }, 'voice webhook for unknown channel');
    return json({ ok: true, ignored: true }, 200);
  }
  const configResult = voiceChannelConfigSchema.safeParse(channel.config);
  const key = masterKey();
  if (!configResult.success || !key) {
    log.error({ channelId }, 'voice channel config invalid or encryption unconfigured');
    return json({ error: 'service unavailable' }, 503);
  }
  const config = configResult.data;

  // 2. Verify the Standard-Webhooks signature with the channel's secret.
  let secret: string;
  try {
    secret = await decryptSecret(config.dispatchSigningSecretEncrypted, key);
  } catch {
    log.error({ channelId }, 'voice signing secret could not be decrypted');
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
    if (error instanceof StandardWebhookVerificationError) {
      log.warn({ channelId }, 'voice webhook signature verification failed');
      return json({ error: 'invalid signature' }, 401);
    }
    return json({ error: 'invalid signature' }, 401);
  }

  // 3. Parse. Non-incoming event types are acknowledged and ignored.
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
    log.warn({ channelId }, 'voice call.incoming payload did not match schema');
    return json({ error: 'invalid payload' }, 400);
  }
  const callId = parsed.data.data.call_id;
  const from = sipHeaderNumber(parsed.data.data.sip_headers, 'From');
  const to = sipHeaderNumber(parsed.data.data.sip_headers, 'To');
  // Twilio stamps its CallSid as a SIP header on trunk originations; the worker
  // needs it to start a per-call recording (recordingEnabled channels).
  const twilioCallSid =
    parsed.data.data.sip_headers.find((h) => h.name.toLowerCase() === 'x-twilio-callsid')?.value ??
    null;

  // Cross-check the dialed number against the channel's registered number.
  if (to && to !== config.phoneNumber) {
    log.info({ channelId }, 'voice webhook To number does not match channel');
    return json({ ok: true, ignored: true }, 200);
  }
  const orgId = channel.org_id;

  // 4. Idempotency fast-path: a redelivered call_id must not create duplicates.
  const { data: existingCall } = await admin
    .from('voice_calls')
    .select('id')
    .eq('provider_call_id', callId)
    .maybeSingle();
  if (existingCall) {
    return json({ ok: true, deduped: true }, 200);
  }

  // 5. Contact + conversation (one conversation per call).
  const contact = await resolveVoiceContact(admin, { orgId, phone: from });
  if (!contact) {
    log.error({ channelId }, 'could not resolve voice contact');
    return json({ error: 'persist failed' }, 500);
  }
  // A freshly created contact is rolled back on every failure path below —
  // duplicate deliveries (especially anonymous callers) must not accumulate
  // orphaned contact rows.
  const rollbackContact = async (): Promise<void> => {
    if (contact.created) {
      await admin.from('contacts').delete().eq('id', contact.id).eq('org_id', orgId);
    }
  };

  const subject = from ? `Anruf von ${from}` : 'Eingehender Anruf';
  const { data: convo, error: convError } = await admin
    .from('conversations')
    .insert({
      org_id: orgId,
      channel_id: channel.id,
      contact_id: contact.id,
      subject,
      status: 'open',
      mode: 'bot',
    })
    .select('id')
    .single();
  if (convError || !convo) {
    await rollbackContact();
    log.error({ channelId }, 'could not create voice conversation');
    return json({ error: 'persist failed' }, 500);
  }
  const conversationId = (convo as { id: string }).id;

  // 6. voice_calls insert fires the dispatch broadcast (0009 trigger). A lost
  //    idempotency race (unique provider_call_id) rolls back the now-empty
  //    conversation + fresh contact and acks the duplicate.
  const { error: callError } = await admin.from('voice_calls').insert({
    org_id: orgId,
    channel_id: channel.id,
    conversation_id: conversationId,
    provider_call_id: callId,
    from_number: from,
    to_number: to ?? config.phoneNumber,
    status: 'ringing',
    ...(twilioCallSid ? { metadata: { twilio_call_sid: twilioCallSid } } : {}),
  });
  if (callError) {
    await admin.from('conversations').delete().eq('id', conversationId).eq('org_id', orgId);
    await rollbackContact();
    if (callError.code === '23505') {
      return json({ ok: true, deduped: true }, 200);
    }
    log.error({ channelId }, 'could not persist voice call');
    return json({ error: 'persist failed' }, 500);
  }

  // Record the call id on the conversation for cross-referencing.
  await admin
    .from('conversations')
    .update({ external_refs: { voice_call_id: callId } })
    .eq('id', conversationId)
    .eq('org_id', orgId);

  log.info({ channelId }, 'voice call ingested');
  return json({ ok: true }, 200);
}
