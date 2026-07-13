import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@zendori/core';
import type { SupabaseClient } from '@zendori/core';
import { normalizeReceivedEmail, resendInboundWebhookSchema } from '@zendori/channels';
import type { UnifiedInboundMessage } from '@zendori/channels';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  downloadAttachment,
  fetchReceivedEmail,
  fetchReceivedEmailAttachments,
  ResendConfigError,
} from '@/lib/email/resend-client';
import { ResendWebhookNotConfiguredError, verifyResendWebhook } from '@/lib/email/verify';

// KI-nahe / IO-heavy webhook: allow more time for attachment downloads.
export const runtime = 'nodejs';
export const maxDuration = 60;

const log = createLogger('resend-ingest');

// Attachment caps (contract): ≤ 15 files, ≤ 15 MB each, ≤ 40 MB total per email.
const MAX_ATTACHMENT_FILES = 15;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL_BYTES = 40 * 1024 * 1024;

/** Loose peek at the event type only — non-object payloads fail, other event types are ignored. */
const eventTypeSchema = z.object({ type: z.string() });

/** Threading refs live on the normalized email metadata (Builder A). */
const emailThreadMetaSchema = z.object({
  in_reply_to: z.string().optional(),
  references: z.array(z.string()).optional(),
});

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

/** Domain part of an address — the only piece of an address we are allowed to log (§7). */
function addressDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : 'unknown';
}

/** Extracts a bare lowercased email address from a raw recipient value ("Name <a@b>" or "a@b"). */
function extractAddress(value: string): string | null {
  const angle = value.match(/<([^>]+)>/);
  const candidate = (angle?.[1] ?? value).trim().toLowerCase();
  return candidate.includes('@') ? candidate : null;
}

/** Makes an attachment filename safe for a storage object key. */
function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const cleaned = base
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'anhang';
}

/** Ensures a filename is unique within one message's folder. */
function uniqueName(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  let candidate = `${stem}-${i}${ext}`;
  while (used.has(candidate)) {
    i += 1;
    candidate = `${stem}-${i}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Downloads an email's attachments and stores them under
 * attachments/<org>/<message_id>/<filename>. Best-effort: the message is already
 * persisted, so failures are logged (metadata only) and skipped, never fatal.
 */
async function storeAttachments(
  admin: SupabaseClient,
  params: { orgId: string; messageId: string; emailId: string }
): Promise<void> {
  const { orgId, messageId, emailId } = params;

  let attachments;
  try {
    attachments = await fetchReceivedEmailAttachments(emailId);
  } catch {
    log.error({ emailId }, 'could not list inbound attachments');
    return;
  }
  if (attachments.length === 0) return;

  const considered = attachments.slice(0, MAX_ATTACHMENT_FILES);
  const usedNames = new Set<string>();
  let totalBytes = 0;
  let stored = 0;
  let skipped =
    attachments.length > MAX_ATTACHMENT_FILES ? attachments.length - MAX_ATTACHMENT_FILES : 0;

  for (const [index, attachment] of considered.entries()) {
    // Pre-download guards on the declared size (when Resend reports it): avoid
    // fetching bytes we would only discard.
    const declaredSize = typeof attachment.size === 'number' ? attachment.size : undefined;
    if (declaredSize !== undefined && declaredSize > MAX_ATTACHMENT_BYTES) {
      skipped += 1;
      log.warn({ emailId }, 'attachment exceeds per-file cap (declared)');
      continue;
    }
    if (declaredSize !== undefined && totalBytes + declaredSize > MAX_ATTACHMENTS_TOTAL_BYTES) {
      skipped += considered.length - index; // this file + all remaining
      log.warn({ emailId }, 'attachment total budget exhausted (declared)');
      break;
    }

    let bytes: Uint8Array;
    try {
      ({ bytes } = await downloadAttachment(attachment.download_url));
    } catch {
      skipped += 1;
      log.warn({ emailId }, 'attachment download failed');
      continue;
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      skipped += 1;
      log.warn({ emailId }, 'attachment exceeds per-file cap');
      continue;
    }
    if (totalBytes + bytes.byteLength > MAX_ATTACHMENTS_TOTAL_BYTES) {
      skipped += considered.length - index; // this file + all remaining
      log.warn({ emailId }, 'attachment total budget exhausted');
      break;
    }

    const filename = uniqueName(
      usedNames,
      safeFilename(attachment.filename ?? `anhang-${index + 1}`)
    );
    const path = `${orgId}/${messageId}/${filename}`;
    const mime = attachment.content_type ?? 'application/octet-stream';

    const { error: uploadError } = await admin.storage.from('attachments').upload(path, bytes, {
      contentType: mime,
      upsert: false,
    });
    if (uploadError) {
      skipped += 1;
      log.warn({ emailId }, 'attachment upload failed');
      continue;
    }

    const { error: rowError } = await admin.from('attachments').insert({
      org_id: orgId,
      message_id: messageId,
      storage_path: path,
      mime,
      size: bytes.byteLength,
    });
    if (rowError) {
      skipped += 1;
      log.warn({ emailId }, 'attachment row insert failed');
      continue;
    }

    totalBytes += bytes.byteLength;
    stored += 1;
  }

  log.info({ emailId, stored, skipped }, 'attachments processed');
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();

  // 1. Svix signature verification on the raw body.
  let event: unknown;
  try {
    event = verifyResendWebhook(rawBody, request.headers);
  } catch (error) {
    if (error instanceof ResendWebhookNotConfiguredError) {
      log.error('resend webhook secret is not configured');
      return json({ error: 'not configured' }, 503);
    }
    log.warn('resend webhook signature verification failed');
    return json({ error: 'invalid signature' }, 401);
  }

  // 2. Only email.received is handled; other verified event types are acknowledged and ignored.
  const typePeek = eventTypeSchema.safeParse(event);
  if (!typePeek.success) {
    return json({ error: 'invalid payload' }, 400);
  }
  if (typePeek.data.type !== 'email.received') {
    return json({ ok: true, ignored: true }, 200);
  }

  const parsed = resendInboundWebhookSchema.safeParse(event);
  if (!parsed.success) {
    log.warn('resend email.received payload did not match schema');
    return json({ error: 'invalid payload' }, 400);
  }
  const webhook = parsed.data;
  const emailId = webhook.data.email_id;

  // 3. Route by received_for / to → the intake address(es) on our domain (handles TO and CC).
  const candidates = Array.from(
    new Set(
      [...(webhook.data.received_for ?? []), ...(webhook.data.to ?? [])]
        .map(extractAddress)
        .filter((address): address is string => address !== null)
    )
  );
  const primaryAddress = candidates[0];
  if (!primaryAddress) {
    log.info({ emailId }, 'resend inbound without a routable recipient');
    return json({ ok: true, ignored: true }, 200);
  }

  // 4. Service-role client (null on preview deployments without the key).
  let admin: SupabaseClient | null;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return json({ error: 'service unavailable' }, 503);
  }
  if (!admin) {
    return json({ error: 'service unavailable' }, 503);
  }

  // 5. Channel lookup: iterate candidates in order (primary recipient first) and
  //    stop at the first active inbound-email channel — deterministic routing when
  //    an email carries several of our intake addresses (TO + CC).
  let channel: { id: string; org_id: string } | undefined;
  for (const candidate of candidates) {
    const { data: channelData, error: channelError } = await admin
      .from('channels')
      .select('id, org_id')
      .eq('type', 'email')
      .eq('is_active', true)
      .eq('config->>mode', 'inbound')
      .eq('config->>address', candidate)
      .limit(1);
    if (channelError) {
      log.error({ emailId }, 'channel lookup failed');
      return json({ error: 'lookup failed' }, 500);
    }
    const found = (channelData ?? [])[0] as { id: string; org_id: string } | undefined;
    if (found) {
      channel = found;
      break;
    }
  }
  if (!channel) {
    // Unknown intake address: log metadata only, then discard (§7).
    log.info(
      { emailId, domain: addressDomain(primaryAddress) },
      'resend inbound for unknown intake address'
    );
    return json({ ok: true, ignored: true }, 200);
  }
  const { id: channelId, org_id: orgId } = channel;

  // 6. Idempotency: a redelivered email_id must not create a duplicate.
  const { data: existing, error: existingError } = await admin
    .from('messages')
    .select('id')
    .eq('channel_id', channelId)
    .eq('external_id', emailId)
    .maybeSingle();
  if (existingError) {
    log.error({ emailId }, 'idempotency lookup failed');
    return json({ error: 'lookup failed' }, 500);
  }
  if (existing) {
    log.info({ emailId }, 'resend inbound already processed (idempotent)');
    return json({ ok: true, deduped: true }, 200);
  }

  // 7. Load the full email and normalize it (Builder A).
  let fullEmail;
  try {
    fullEmail = await fetchReceivedEmail(emailId);
  } catch (error) {
    if (error instanceof ResendConfigError) {
      log.error({ emailId }, 'resend client is not configured');
      return json({ error: 'service unavailable' }, 503);
    }
    log.error({ emailId }, 'could not fetch received email');
    return json({ error: 'upstream failure' }, 502);
  }

  let normalized: UnifiedInboundMessage;
  try {
    normalized = normalizeReceivedEmail(webhook, fullEmail);
  } catch {
    log.error({ emailId }, 'could not normalize received email');
    return json({ error: 'normalization failed' }, 500);
  }

  // 8. Contact = envelope sender (dedupe by lowercased email within the org).
  const email = normalized.contact.email?.toLowerCase() ?? null;
  const name = normalized.contact.name ?? null;
  const contactId = await resolveContact(admin, { orgId, email, name });
  if (!contactId) {
    log.error({ emailId }, 'could not resolve contact');
    return json({ error: 'persist failed' }, 500);
  }

  // 9. Threading: match a prior message of this channel by RFC Message-ID
  //    (an intake address threads only within its own channel's conversations).
  const threadRefs = collectThreadRefs(normalized.metadata);
  let conversationId: string | null = null;
  if (threadRefs.length > 0) {
    const { data: threadRows, error: threadError } = await admin
      .from('messages')
      .select('conversation_id')
      .eq('org_id', orgId)
      .eq('channel_id', channelId)
      .in('metadata->email->>message_id', threadRefs)
      .order('created_at', { ascending: false })
      .limit(1);
    if (threadError) {
      log.error({ emailId }, 'threading lookup failed');
      return json({ error: 'lookup failed' }, 500);
    }
    const matched = (threadRows ?? [])[0] as { conversation_id: string } | undefined;
    if (matched) conversationId = matched.conversation_id;
  }

  // 10. Conversation: reopen the matched one (resolved → open) or create a new one.
  //     Track a freshly created conversation so we can roll it back if the message
  //     insert then loses an idempotency race (23505) and leaves it empty.
  let createdConversationId: string | null = null;
  if (conversationId) {
    await admin
      .from('conversations')
      .update({ status: 'open' })
      .eq('id', conversationId)
      .eq('org_id', orgId)
      .eq('status', 'resolved');
  } else {
    const { data: convo, error: convError } = await admin
      .from('conversations')
      .insert({
        org_id: orgId,
        channel_id: channelId,
        contact_id: contactId,
        subject: webhook.data.subject ?? null,
        status: 'open',
        mode: 'bot',
      })
      .select('id')
      .single();
    if (convError || !convo) {
      log.error({ emailId }, 'could not create conversation');
      return json({ error: 'persist failed' }, 500);
    }
    conversationId = (convo as { id: string }).id;
    createdConversationId = conversationId;
  }

  // 11. Persist the inbound message (idempotent via unique (channel_id, external_id)).
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
      external_id: emailId,
      metadata: normalized.metadata,
      processing_state: 'pending',
    })
    .select('id')
    .single();
  if (messageError) {
    if (messageError.code === '23505') {
      // Lost the idempotency race: if WE created a new conversation for this
      // (now-duplicate) message, it is empty — remove it before acknowledging.
      if (createdConversationId) {
        await admin
          .from('conversations')
          .delete()
          .eq('id', createdConversationId)
          .eq('org_id', orgId);
      }
      log.info({ emailId }, 'resend inbound duplicate on insert (idempotent)');
      return json({ ok: true, deduped: true }, 200);
    }
    log.error({ emailId }, 'could not persist message');
    return json({ error: 'persist failed' }, 500);
  }
  const messageId = (inserted as { id: string }).id;

  // 12. Attachments (best-effort; message stays even if these fail).
  const attachmentCount = webhook.data.attachments?.length ?? 0;
  if (attachmentCount > 0) {
    await storeAttachments(admin, { orgId, messageId, emailId });
  }

  log.info({ emailId }, 'resend inbound processed');
  return json({ ok: true }, 200);
}

/** Resolves the sender contact: find-or-create by email, or create a bare contact when no email is present. */
async function resolveContact(
  admin: SupabaseClient,
  params: { orgId: string; email: string | null; name: string | null }
): Promise<string | null> {
  const { orgId, email, name } = params;

  if (email) {
    const { data: rows, error } = await admin
      .from('contacts')
      .select('id, name')
      .eq('org_id', orgId)
      .eq('email', email)
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) return null;
    const existing = (rows ?? [])[0] as { id: string; name: string | null } | undefined;
    if (existing) {
      if (!existing.name && name) {
        await admin.from('contacts').update({ name }).eq('id', existing.id).eq('org_id', orgId);
      }
      return existing.id;
    }
  }

  const { data: created, error: createError } = await admin
    .from('contacts')
    .insert({ org_id: orgId, email, name })
    .select('id')
    .single();
  if (createError || !created) return null;
  return (created as { id: string }).id;
}

/** Collects candidate RFC Message-IDs (In-Reply-To + References) from the normalized metadata. */
function collectThreadRefs(metadata: Record<string, unknown>): string[] {
  const parsed = emailThreadMetaSchema.safeParse(metadata.email);
  if (!parsed.success) return [];
  const refs = new Set<string>();
  if (parsed.data.in_reply_to) refs.add(parsed.data.in_reply_to);
  for (const reference of parsed.data.references ?? []) refs.add(reference);
  return Array.from(refs);
}
