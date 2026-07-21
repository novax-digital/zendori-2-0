import { NextResponse } from 'next/server';
import { createLogger, decryptSecret } from '@zendori/core';
import type { SupabaseClient } from '@zendori/core';
import {
  normalizeWhatsAppTwilio,
  parseTwilioInbound,
  shouldStartNewConversation,
  twilioStatusSchema,
  verifyTwilioSignature,
  whatsappTwilioConfigSchema,
  type TwilioInboundMedia,
  type UnifiedInboundMessage,
} from '@zendori/channels';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { appUrl } from '@/lib/env';

// Twilio inbound WhatsApp webhook (Phase 7a). Twilio POSTs x-www-form-urlencoded,
// signs it with X-Twilio-Signature (HMAC-SHA1 over the exact public URL + sorted
// params, keyed by the account AuthToken). We route by the `To` sender number,
// decrypt that channel's AuthToken, verify, then persist with
// processing_state='pending'. IO-heavy (media downloads) → nodejs + maxDuration.
export const runtime = 'nodejs';
export const maxDuration = 60;

const log = createLogger('twilio-whatsapp-ingest');

const MAX_MEDIA_FILES = 10;
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
const MAX_MEDIA_TOTAL_BYTES = 40 * 1024 * 1024;

/** The exact public URL Twilio signs — must match the configured webhook URL. */
const WEBHOOK_PATH = '/api/hooks/whatsapp/twilio';

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

/** Empty TwiML — tells Twilio "handled, do not retry" without sending a reply. */
function emptyTwiml(): NextResponse {
  return new NextResponse('<Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

function masterKey(): string | null {
  const key = process.env.MASTER_ENCRYPTION_KEY;
  return key && key.length > 0 ? key : null;
}

// Delivery lifecycle order. Twilio does not guarantee callback ordering, so the
// stored status only ever advances: an out-of-order callback can't lower it, and
// a terminal failed/undelivered is not overwritten by a non-terminal one.
const STATUS_RANK: Record<string, number> = { queued: 1, sent: 2, delivered: 3, read: 4 };
function isTerminalError(s: string | undefined): boolean {
  return s === 'failed' || s === 'undelivered';
}
function advanceStatus(existing: string | undefined, incoming: string): string {
  if (!existing) return incoming;
  if (isTerminalError(existing) && !isTerminalError(incoming)) return existing;
  if (!isTerminalError(incoming) && (STATUS_RANK[incoming] ?? 0) < (STATUS_RANK[existing] ?? 0)) {
    return existing;
  }
  return incoming;
}

/** Makes a media filename safe for a storage object key. */
function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'medien';
}

/** Guesses an extension from a MIME type for the stored filename. */
function extForMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/amr': 'amr',
    'video/mp4': 'mp4',
    'application/pdf': 'pdf',
  };
  return map[mime.split(';')[0]!.trim()] ?? 'bin';
}

/**
 * Downloads Twilio media (Basic auth AccountSid:AuthToken required — a plain GET
 * 401s) and stores each part under attachments/<org>/<message_id>/<file>.
 * Best-effort: the message is already persisted, so failures are logged
 * (metadata only, §7) and skipped, never fatal.
 */
async function storeTwilioMedia(
  admin: SupabaseClient,
  params: {
    orgId: string;
    messageId: string;
    messageSid: string;
    media: TwilioInboundMedia[];
    accountSid: string;
    authToken: string;
  }
): Promise<void> {
  const { orgId, messageId, messageSid, media, accountSid, authToken } = params;
  const auth = Buffer.from(`${accountSid}:${authToken}`, 'utf8').toString('base64');
  const considered = media.slice(0, MAX_MEDIA_FILES);
  let totalBytes = 0;

  for (const [index, part] of considered.entries()) {
    let bytes: Uint8Array;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(part.url, {
        headers: { Authorization: `Basic ${auth}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        log.warn({ messageSid }, 'twilio media download returned non-ok');
        continue;
      }
      // Skip BEFORE buffering when the declared size already blows the cap, so a
      // huge media URL can't be fully read into the function's heap.
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
        log.warn({ messageSid }, 'twilio media exceeds per-file cap (declared)');
        continue;
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      log.warn({ messageSid }, 'twilio media download failed');
      continue;
    } finally {
      clearTimeout(timeout);
    }
    // Backstop for chunked responses without a content-length header.
    if (bytes.byteLength > MAX_MEDIA_BYTES) {
      log.warn({ messageSid }, 'twilio media exceeds per-file cap');
      continue;
    }
    if (totalBytes + bytes.byteLength > MAX_MEDIA_TOTAL_BYTES) {
      log.warn({ messageSid }, 'twilio media total budget exhausted');
      break;
    }

    const filename = safeFilename(`medien-${index + 1}.${extForMime(part.contentType)}`);
    const path = `${orgId}/${messageId}/${filename}`;
    const { error: uploadError } = await admin.storage
      .from('attachments')
      .upload(path, bytes, { contentType: part.contentType, upsert: false });
    if (uploadError) {
      log.warn({ messageSid }, 'twilio media upload failed');
      continue;
    }
    const { error: rowError } = await admin.from('attachments').insert({
      org_id: orgId,
      message_id: messageId,
      storage_path: path,
      mime: part.contentType,
      size: bytes.byteLength,
    });
    if (rowError) {
      log.warn({ messageSid }, 'twilio media row insert failed');
      continue;
    }
    totalBytes += bytes.byteLength;
  }
}

type TwilioChannel = {
  id: string;
  org_id: string;
  config: unknown;
};

/** Loads the active Twilio WhatsApp channel whose sender matches the given +E164. */
async function findChannelBySender(
  admin: SupabaseClient,
  sender: string
): Promise<TwilioChannel | null> {
  const { data, error } = await admin
    .from('channels')
    .select('id, org_id, config')
    .eq('type', 'whatsapp')
    .eq('is_active', true)
    .eq('config->>provider', 'twilio')
    .eq('config->>sender', sender)
    .order('created_at', { ascending: true }) // deterministic tiebreak (unique index 0008 is the real guard)
    .limit(1);
  if (error) return null;
  return ((data ?? [])[0] as TwilioChannel | undefined) ?? null;
}

/** Resolves (find-or-create) the WhatsApp contact by wa_id within the org. */
async function resolveWhatsAppContact(
  admin: SupabaseClient,
  params: { orgId: string; waId: string; phone: string; name: string | null }
): Promise<string | null> {
  const { orgId, waId, phone, name } = params;
  const { data: rows } = await admin
    .from('contacts')
    .select('id, name')
    .eq('org_id', orgId)
    .eq('wa_id', waId)
    .order('created_at', { ascending: true })
    .limit(1);
  const existing = (rows ?? [])[0] as { id: string; name: string | null } | undefined;
  if (existing) {
    if (!existing.name && name) {
      await admin.from('contacts').update({ name }).eq('id', existing.id).eq('org_id', orgId);
    }
    return existing.id;
  }
  const { data: created, error } = await admin
    .from('contacts')
    .insert({ org_id: orgId, wa_id: waId, phone, name })
    .select('id')
    .single();
  if (error || !created) return null;
  return (created as { id: string }).id;
}

/** Handles a Twilio delivery-status callback: match the outbound row by SID, merge status. */
async function handleStatusCallback(
  admin: SupabaseClient,
  params: Record<string, string>,
  signature: string | null,
  requestUrl: string
): Promise<NextResponse> {
  const parsed = twilioStatusSchema.safeParse(params);
  if (!parsed.success) return json({ ok: true, ignored: true }, 200);
  const { MessageSid, MessageStatus, ErrorCode } = parsed.data;

  // Find our outbound message by the stored SID to learn org + channel.
  const { data: msgRow } = await admin
    .from('messages')
    .select('id, org_id, channel_id, metadata')
    .eq('metadata->whatsapp->>message_sid', MessageSid)
    .limit(1)
    .maybeSingle();
  const message = msgRow as
    | { id: string; org_id: string; channel_id: string; metadata: Record<string, unknown> | null }
    | undefined;
  if (!message) return json({ ok: true, ignored: true }, 200);

  const { data: channelRow } = await admin
    .from('channels')
    .select('config')
    .eq('id', message.channel_id)
    .maybeSingle();
  const configResult = whatsappTwilioConfigSchema.safeParse(
    (channelRow as { config: unknown } | null)?.config
  );
  const key = masterKey();
  if (!configResult.success || !key) return json({ ok: true, ignored: true }, 200);

  let authToken: string;
  try {
    authToken = await decryptSecret(configResult.data.authTokenEncrypted, key);
  } catch {
    return json({ ok: true, ignored: true }, 200);
  }
  if (!verifyTwilioSignature(authToken, requestUrl, params, signature)) {
    return json({ error: 'invalid signature' }, 403);
  }

  const existingWa = (message.metadata?.whatsapp ?? {}) as Record<string, unknown>;
  const nextStatus = advanceStatus(
    typeof existingWa.status === 'string' ? existingWa.status : undefined,
    MessageStatus
  );
  const nextMetadata = {
    ...(message.metadata ?? {}),
    whatsapp: {
      ...existingWa,
      status: nextStatus,
      ...(ErrorCode ? { error_code: ErrorCode } : {}),
    },
  };
  await admin
    .from('messages')
    .update({ metadata: nextMetadata })
    .eq('org_id', message.org_id)
    .eq('id', message.id);
  return json({ ok: true }, 200);
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get('x-twilio-signature');

  // Parse the form params without reordering; Twilio's HMAC covers all of them.
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(rawBody)) params[k] = v;

  // Reconstruct the exact URL Twilio signed: the trusted APP_URL origin (never
  // the proxied request host) + the path and query actually delivered. This
  // tolerates a trailing slash or a disambiguating query string on the
  // registered webhook/StatusCallback URL, which Twilio includes in its HMAC.
  let requestUrl: string;
  try {
    const incoming = new URL(request.url);
    requestUrl = `${new URL(appUrl()).origin}${incoming.pathname}${incoming.search}`;
  } catch {
    requestUrl = `${appUrl().replace(/\/+$/, '')}${WEBHOOK_PATH}`;
  }

  let admin: SupabaseClient | null;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return json({ error: 'service unavailable' }, 503);
  }
  if (!admin) return json({ error: 'service unavailable' }, 503);

  // Delivery-status callback (has MessageStatus) — separate handling.
  if (typeof params.MessageStatus === 'string' && params.MessageStatus.length > 0) {
    return handleStatusCallback(admin, params, signature, requestUrl);
  }

  // Inbound message. Route by `To` sender number BEFORE verifying (the AuthToken
  // that verifies the signature is per-channel; verify-before-acting).
  const toRaw = params.To;
  if (typeof toRaw !== 'string' || toRaw.length === 0) {
    return emptyTwiml();
  }
  const sender = toRaw.startsWith('whatsapp:') ? toRaw.slice('whatsapp:'.length) : toRaw;

  const channel = await findChannelBySender(admin, sender);
  if (!channel) {
    // Unknown sender: metadata-only log, ack empty so Twilio does not retry-storm.
    log.info({ sender: sender.slice(-4) }, 'twilio inbound for unknown sender');
    return emptyTwiml();
  }

  const configResult = whatsappTwilioConfigSchema.safeParse(channel.config);
  const key = masterKey();
  if (!configResult.success || !key) {
    return json({ error: 'service unavailable' }, 503);
  }

  let authToken: string;
  try {
    authToken = await decryptSecret(configResult.data.authTokenEncrypted, key);
  } catch {
    return json({ error: 'service unavailable' }, 503);
  }

  if (!verifyTwilioSignature(authToken, requestUrl, params, signature)) {
    log.warn({ sender: sender.slice(-4) }, 'twilio signature verification failed');
    return json({ error: 'invalid signature' }, 403);
  }

  const parsedMessage = parseTwilioInbound(params);
  if (!parsedMessage) {
    return json({ error: 'invalid payload' }, 400);
  }
  const messageSid = parsedMessage.MessageSid;
  const orgId = channel.org_id;
  const channelId = channel.id;

  // Idempotency: a redelivered MessageSid must not create a duplicate.
  const { data: existing, error: existingError } = await admin
    .from('messages')
    .select('id')
    .eq('channel_id', channelId)
    .eq('external_id', messageSid)
    .maybeSingle();
  if (existingError) {
    log.error({ messageSid }, 'idempotency lookup failed');
    return json({ error: 'lookup failed' }, 500);
  }
  if (existing) {
    return json({ ok: true, deduped: true }, 200);
  }

  let normalized: UnifiedInboundMessage;
  try {
    normalized = normalizeWhatsAppTwilio(parsedMessage, new Date().toISOString());
  } catch {
    log.error({ messageSid }, 'could not normalize twilio message');
    return json({ error: 'normalization failed' }, 500);
  }

  const waId = normalized.contact.waId ?? '';
  const phone = normalized.contact.phone ?? '';
  const contactId = await resolveWhatsAppContact(admin, {
    orgId,
    waId,
    phone,
    name: normalized.contact.name ?? null,
  });
  if (!contactId) {
    log.error({ messageSid }, 'could not resolve contact');
    return json({ error: 'persist failed' }, 500);
  }

  // Threading: newest open/pending conversation for (org, channel, contact),
  // else create. Ticket separation: when the channel has an inactivity window
  // configured and every candidate OPEN conversation is past it, the message
  // starts a NEW conversation (`pending` never splits — §6 waiting queue).
  // A few candidates (not one) are scanned so that a conversation a CONCURRENT
  // delivery just created (last_message_at still null until its message
  // commits) is reused instead of tearing a message burst into several fresh
  // tickets; nullsFirst puts exactly those rows in front.
  const { data: convRows } = await admin
    .from('conversations')
    .select('id, status, last_message_at')
    .eq('org_id', orgId)
    .eq('channel_id', channelId)
    .eq('contact_id', contactId)
    .in('status', ['open', 'pending'])
    .order('last_message_at', { ascending: false, nullsFirst: true })
    .order('created_at', { ascending: false })
    .limit(3);
  const candidates = (convRows ?? []) as {
    id: string;
    status: string;
    last_message_at: string | null;
  }[];
  const appendTarget = candidates.find(
    (c) =>
      !shouldStartNewConversation(
        { status: c.status, lastMessageAt: c.last_message_at },
        configResult.data.conversationSplitHours
      )
  );
  let conversationId = appendTarget?.id ?? null;
  let createdConversationId: string | null = null;
  if (!conversationId) {
    const { data: convo, error: convError } = await admin
      .from('conversations')
      .insert({
        org_id: orgId,
        channel_id: channelId,
        contact_id: contactId,
        status: 'open',
        mode: 'bot',
      })
      .select('id')
      .single();
    if (convError || !convo) {
      log.error({ messageSid }, 'could not create conversation');
      return json({ error: 'persist failed' }, 500);
    }
    conversationId = (convo as { id: string }).id;
    createdConversationId = conversationId;
  }

  const { data: inserted, error: messageError } = await admin
    .from('messages')
    .insert({
      org_id: orgId,
      conversation_id: conversationId,
      channel_id: channelId,
      direction: 'in',
      sender_type: 'contact',
      content: normalized.content,
      content_type: normalized.contentType,
      external_id: messageSid,
      metadata: normalized.metadata,
      processing_state: 'pending',
    })
    .select('id')
    .single();
  if (messageError) {
    if (messageError.code === '23505') {
      if (createdConversationId) {
        await admin
          .from('conversations')
          .delete()
          .eq('id', createdConversationId)
          .eq('org_id', orgId);
      }
      return json({ ok: true, deduped: true }, 200);
    }
    log.error({ messageSid }, 'could not persist message');
    return json({ error: 'persist failed' }, 500);
  }
  const messageId = (inserted as { id: string }).id;

  // Media (best-effort; message already persisted). Requires Basic auth.
  if (parsedMessage.media.length > 0) {
    await storeTwilioMedia(admin, {
      orgId,
      messageId,
      messageSid,
      media: parsedMessage.media,
      accountSid: configResult.data.accountSid,
      authToken,
    });
  }

  log.info({ messageSid }, 'twilio inbound processed');
  return json({ ok: true }, 200);
}
