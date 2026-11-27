import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@zendori/core';
import { isTestConversation } from '@zendori/core';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { corsHeaders, preflight } from '@/lib/widget/cors';
import { findWidgetChannelByToken, verifySession, WidgetDbError } from '@/lib/widget/session';
import { findWidgetChannelForTest } from '@/lib/widget/test-mode';

const bodySchema = z
  .object({
    token: z.string().regex(/^[0-9a-f]{32}$/),
    // the channel's own "Test" tab (0050): signed-in members only, drafts included
    test: z.literal(true).optional(),
    conversationId: z.uuid(),
    secret: z.string().regex(/^[0-9a-f]{48}$/),
    clientMessageId: z.uuid(),
    content: z.string().min(1).max(4000).optional(),
    contact: z
      .object({
        name: z.string().max(200).optional(),
        email: z.email().optional(),
      })
      .optional(),
  })
  .refine((body) => body.content !== undefined || body.contact !== undefined, {
    message: 'content oder contact erforderlich',
  });

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders() });
}

function serviceUnavailable(): NextResponse {
  return json(
    { error: 'Dienst vorübergehend nicht verfügbar. Bitte versuchen Sie es gleich erneut.' },
    503
  );
}

/**
 * Applies optional contact details to the session's OWN contact row only.
 * Last submitted value wins. Deliberately no merging with other contacts of
 * the org that share the email: in a chat the address is only CLAIMED — the
 * answers go back into this browser, not to that mailbox — so taking over an
 * existing contact would hand its identity (and whatever a data action looks up
 * for it) to anyone who types the address.
 *
 * An e-mail address is unique per org (0006). When it already belongs to
 * another contact, the name is still saved and the claimed address is kept for
 * the team as an internal note (keepClaimedEmailAsNote) — the visitor gets the
 * same "saved" as for any other address. Returns false if persisting failed.
 */
async function applyContactUpdate(
  admin: SupabaseClient,
  params: {
    orgId: string;
    conversationId: string;
    contactId: string | null;
    name?: string;
    email?: string;
  }
): Promise<boolean> {
  const { orgId, conversationId, contactId, name, email } = params;
  if (name === undefined && email === undefined) return true;

  const patch: { name?: string; email?: string } = {};
  if (name !== undefined) patch.name = name;
  if (email !== undefined) patch.email = email;

  if (contactId) {
    const { error } = await admin
      .from('contacts')
      .update(patch)
      .eq('id', contactId)
      .eq('org_id', orgId);
    if (!error) return true;
    if (error.code === '23505' && email !== undefined) {
      return keepClaimedEmailAsNote(admin, { orgId, conversationId, contactId, email, name });
    }
    return false;
  }

  // session without a contact → create our own and attach it to the conversation
  const { data: insertedContact, error: insertError } = await admin
    .from('contacts')
    .insert({ org_id: orgId, name: name ?? null, email: email ?? null })
    .select('id')
    .single();
  if (insertError || !insertedContact) return false;
  const { error: attachError } = await admin
    .from('conversations')
    .update({ contact_id: (insertedContact as { id: string }).id })
    .eq('id', conversationId)
    .eq('org_id', orgId);
  return !attachError;
}

/**
 * The e-mail the visitor entered already belongs to another contact of the org
 * (a returning visitor in a new browser, someone who wrote by e-mail before —
 * or somebody typing an address that is not theirs). Until 2026-11-27 the save
 * simply failed, which also told the visitor that the address is known. Now:
 * the name goes onto the session's own contact, and the address is left for the
 * team as an internal note on the conversation — once, however often it is sent.
 * Whether the two contacts are the same person stays a human decision.
 */
async function keepClaimedEmailAsNote(
  admin: SupabaseClient,
  params: { orgId: string; conversationId: string; contactId: string; email: string; name?: string }
): Promise<boolean> {
  const { orgId, conversationId, contactId, email, name } = params;
  if (name !== undefined) {
    const { error: nameError } = await admin
      .from('contacts')
      .update({ name })
      .eq('id', contactId)
      .eq('org_id', orgId);
    if (nameError) return false;
  }
  const content =
    `Im Chat angegebene E-Mail-Adresse: ${email}. Sie gehört bereits zu einem anderen Kontakt ` +
    'und wurde deshalb nicht übernommen (die Angabe ist unbestätigt).';
  const { data: existing, error: lookupError } = await admin
    .from('notes')
    .select('id')
    .eq('org_id', orgId)
    .eq('conversation_id', conversationId)
    .eq('content', content)
    .limit(1);
  if (lookupError) return false;
  if ((existing ?? []).length > 0) return true;
  const { error: noteError } = await admin
    .from('notes')
    .insert({ org_id: orgId, conversation_id: conversationId, author_id: null, content });
  return !noteError;
}

export function OPTIONS(): Response {
  return preflight();
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
  const { token, conversationId, secret, clientMessageId, content, contact } = parsed.data;
  const test = parsed.data.test === true;

  const [ipAllowed, conversationAllowed] = await Promise.all([
    checkRateLimit('widget-message-ip', clientIp(request)),
    checkRateLimit('widget-message-conversation', conversationId),
  ]);
  if (!ipAllowed || !conversationAllowed) {
    return json({ error: 'Zu viele Anfragen. Bitte versuchen Sie es gleich erneut.' }, 429);
  }

  let admin;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return serviceUnavailable();
  }
  if (!admin) {
    return serviceUnavailable();
  }

  // full validation chain: token → active widget channel → session (hash) → same channel
  let channel;
  let verified;
  try {
    channel = test
      ? await findWidgetChannelForTest(admin, token)
      : await findWidgetChannelByToken(admin, token);
    if (channel) {
      verified = await verifySession(admin, conversationId, secret);
    }
  } catch (error) {
    if (error instanceof WidgetDbError) return serviceUnavailable();
    throw error;
  }
  if (!channel) {
    return json({ error: 'Widget wurde nicht gefunden.' }, 404);
  }
  if (!verified || verified.session.channel_id !== channel.id) {
    return json({ error: 'Sitzung ist ungültig oder abgelaufen.' }, 401);
  }
  const session = verified.session;
  if (test) {
    // the "Test" tab writes into test conversations only — never into a real one
    let isTest: boolean;
    try {
      isTest = await isTestConversation(admin, channel.org_id, session.conversation_id);
    } catch {
      return serviceUnavailable();
    }
    if (!isTest) return json({ error: 'Sitzung ist ungültig oder abgelaufen.' }, 401);
  }
  // AUTHORITATIVE conversation: may differ from the client-sent id when the
  // session was rotated by ticket separation (stale tab) — messages must land
  // in the session's CURRENT conversation, never in the abandoned one.
  const targetConversationId = session.conversation_id;

  await admin
    .from('widget_sessions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', session.id)
    .eq('org_id', channel.org_id);

  // --- optional contact details (may arrive with or without a message)
  const contactName = contact?.name?.trim() ? contact.name.trim() : undefined;
  const contactEmail = contact?.email ? contact.email.trim().toLowerCase() : undefined;
  const contactSaved = await applyContactUpdate(admin, {
    orgId: channel.org_id,
    conversationId: targetConversationId,
    contactId: session.contact_id,
    name: contactName,
    email: contactEmail,
  });
  if (content === undefined) {
    // contact-only request: report the outcome of the contact update
    if (!contactSaved) {
      return json({ error: 'Kontaktdaten konnten nicht gespeichert werden.' }, 500);
    }
    return json({ ok: true, deduped: false }, 200);
  }

  // --- message insert, idempotent via external_id (unique per channel)
  const { error: messageError } = await admin.from('messages').insert({
    org_id: channel.org_id,
    conversation_id: targetConversationId,
    channel_id: channel.id,
    direction: 'in',
    sender_type: 'contact',
    content,
    content_type: 'text',
    external_id: `widget-${clientMessageId}`,
    processing_state: 'pending',
  });
  if (messageError) {
    if (messageError.code === '23505') {
      return json({ ok: true, deduped: true }, 200);
    }
    return json({ error: 'Nachricht konnte nicht gesendet werden.' }, 500);
  }

  // an inbound message re-opens a resolved conversation (best-effort)
  await admin
    .from('conversations')
    .update({ status: 'open' })
    .eq('id', targetConversationId)
    .eq('org_id', channel.org_id)
    .eq('status', 'resolved');

  return json({ ok: true, deduped: false }, 200);
}
