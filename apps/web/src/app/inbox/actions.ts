'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { conversationStatusSchema } from '@zendori/core';
import type { SupabaseClient } from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { deliverOutboundEmail } from '@/lib/email/dispatch';
import { deliverOutboundWhatsApp } from '@/lib/whatsapp/dispatch';

// --- form field helpers ------------------------------------------------------

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalField(value: FormDataEntryValue | null): string | undefined {
  const text = textField(value);
  return text === '' ? undefined : text;
}

/** Keeps the status filter only if it is a valid value, otherwise falls back to 'all'. */
function sanitizeFilterStatus(value: FormDataEntryValue | null): string {
  const v = typeof value === 'string' ? value : '';
  return v === 'open' || v === 'pending' || v === 'resolved' ? v : 'all';
}

/** Keeps the channel filter only if it is a uuid, otherwise falls back to 'all'. */
function sanitizeFilterChannel(value: FormDataEntryValue | null): string {
  const v = typeof value === 'string' ? value : '';
  return z.uuid().safeParse(v).success ? v : 'all';
}

// --- redirect targets (always preserve org/c/status/channel) ------------------

type InboxRedirect = {
  org: string;
  c?: string;
  status: string;
  channel: string;
  error?: string;
  notice?: string;
};

function inboxUrl(target: InboxRedirect): string {
  const params = new URLSearchParams();
  params.set('org', target.org);
  if (target.c) params.set('c', target.c);
  params.set('status', target.status);
  params.set('channel', target.channel);
  if (target.error) params.set('error', target.error);
  if (target.notice) params.set('notice', target.notice);
  return `/inbox?${params.toString()}`;
}

function cannedResponsesUrl(org: string, error?: string): string {
  const params = new URLSearchParams({ org });
  if (error) params.set('error', error);
  return `/settings/canned-responses?${params.toString()}`;
}

function channelsUrl(org: string, error?: string): string {
  const params = new URLSearchParams({ org });
  if (error) params.set('error', error);
  return `/settings/channels?${params.toString()}`;
}

function testChannelUrl(org: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/test-channel?${params.toString()}`;
}

/** Redirect target built from the raw form fields (used when validation fails). */
function fallbackInboxRedirect(formData: FormData, error: string): InboxRedirect {
  return {
    org: textField(formData.get('org')),
    c: textField(formData.get('conversationId')),
    status: sanitizeFilterStatus(formData.get('filterStatus')),
    channel: sanitizeFilterChannel(formData.get('filterChannel')),
    error,
  };
}

// --- inbox actions -------------------------------------------------------------

const replySchema = z.object({
  org: z.uuid(),
  conversationId: z.uuid(),
  content: z.string().min(1),
});

/**
 * Returns the error instead of redirecting so the Composer can keep the
 * agent's draft on failure; on success it redirects like the other actions.
 */
export async function sendReply(formData: FormData): Promise<{ error: string } | void> {
  const errorText = 'Antwort konnte nicht gesendet werden.';
  const parsed = replySchema.safeParse({
    org: formData.get('org'),
    conversationId: formData.get('conversationId'),
    content: textField(formData.get('content')),
  });
  if (!parsed.success) {
    return { error: errorText };
  }
  const { org, conversationId, content } = parsed.data;
  const base: InboxRedirect = {
    org,
    c: conversationId,
    status: sanitizeFilterStatus(formData.get('filterStatus')),
    channel: sanitizeFilterChannel(formData.get('filterChannel')),
  };

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('conversations')
    .select('id, channel_id')
    .eq('org_id', org)
    .eq('id', conversationId)
    .maybeSingle();
  const conversation = data as { id: string; channel_id: string } | null;
  if (!conversation) {
    return { error: errorText };
  }

  const { data: insertedRow, error } = await supabase
    .from('messages')
    .insert({
      org_id: org,
      conversation_id: conversationId,
      channel_id: conversation.channel_id,
      direction: 'out',
      sender_type: 'agent',
      content,
      content_type: 'text',
      processing_state: null,
    })
    .select('id')
    .single();
  if (error || !insertedRow) {
    return { error: errorText };
  }
  const messageId = (insertedRow as { id: string }).id;

  // Email/inbound channels: actually deliver the reply via Resend and record the
  // outcome on the message. Every other channel keeps the Phase-1 persist-only
  // behavior (the reply just appears in the thread).
  const { data: channelRow } = await supabase
    .from('channels')
    .select('type, config')
    .eq('org_id', org)
    .eq('id', conversation.channel_id)
    .maybeSingle();
  const channel = channelRow as { type: string; config: { mode?: unknown } } | null;
  const isInboundEmail = channel?.type === 'email' && channel.config.mode === 'inbound';

  if (isInboundEmail) {
    const admin = createSupabaseAdminClient();
    const result = admin
      ? await deliverOutboundEmail(admin, {
          conversationId,
          orgId: org,
          channelId: conversation.channel_id,
          content,
        })
      : ({ ok: false, error: 'E-Mail-Versand ist serverseitig nicht konfiguriert.' } as const);

    if (!result.ok) {
      // reply is saved; flag the failed delivery so the agent can retry / follow up
      await supabase
        .from('messages')
        .update({ metadata: { delivery: { failed: true, error: result.error } } })
        .eq('org_id', org)
        .eq('id', messageId);
      revalidatePath('/inbox');
      redirect(
        inboxUrl({
          ...base,
          error: `Antwort gespeichert, aber E-Mail-Versand fehlgeschlagen: ${result.error}`,
        })
      );
    }

    // store the outbound Message-ID so inbound replies thread back to this message
    await supabase
      .from('messages')
      .update({ metadata: { email: { message_id: result.messageId } } })
      .eq('org_id', org)
      .eq('id', messageId);
  } else if (channel?.type === 'whatsapp') {
    // WhatsApp: deliver via the provider adapter. Agent replies never fall back
    // to a template — outside the 24h window the send fails and is flagged so the
    // agent knows their text did not reach the customer.
    const admin = createSupabaseAdminClient();
    const result = admin
      ? await deliverOutboundWhatsApp(admin, {
          conversationId,
          orgId: org,
          channelId: conversation.channel_id,
          content,
        })
      : ({ ok: false, error: 'WhatsApp-Versand ist serverseitig nicht konfiguriert.' } as const);

    if (!result.ok) {
      await supabase
        .from('messages')
        .update({ metadata: { delivery: { failed: true, error: result.error } } })
        .eq('org_id', org)
        .eq('id', messageId);
      revalidatePath('/inbox');
      redirect(
        inboxUrl({
          ...base,
          error: `Antwort gespeichert, aber WhatsApp-Versand fehlgeschlagen: ${result.error}`,
        })
      );
    }

    await supabase
      .from('messages')
      .update({ metadata: { whatsapp: { message_sid: result.externalId } } })
      .eq('org_id', org)
      .eq('id', messageId);
  }

  revalidatePath('/inbox');
  redirect(inboxUrl(base));
}

const statusSchema = z.object({
  org: z.uuid(),
  conversationId: z.uuid(),
  status: conversationStatusSchema,
});

export async function setConversationStatus(formData: FormData): Promise<void> {
  const errorText = 'Status konnte nicht geändert werden.';
  const parsed = statusSchema.safeParse({
    org: formData.get('org'),
    conversationId: formData.get('conversationId'),
    status: formData.get('status'),
  });
  if (!parsed.success) {
    redirect(inboxUrl(fallbackInboxRedirect(formData, errorText)));
  }
  const { org, conversationId, status } = parsed.data;
  const base: InboxRedirect = {
    org,
    c: conversationId,
    status: sanitizeFilterStatus(formData.get('filterStatus')),
    channel: sanitizeFilterChannel(formData.get('filterChannel')),
  };

  const supabase = await createSupabaseServerClient();

  // Resolving a conversation should push the closing state to HubSpot (stage
  // change / follow-up note). Only mark it "due" when the org actually has an
  // active HubSpot integration, so non-HubSpot orgs never accumulate due rows.
  const updatePayload: { status: typeof status; hubspot_sync_requested_at?: string } = { status };
  if (status === 'resolved') {
    const { data: integration } = await supabase
      .from('integrations')
      .select('id')
      .eq('org_id', org)
      .eq('type', 'hubspot')
      .eq('is_active', true)
      .maybeSingle();
    if (integration) {
      updatePayload.hubspot_sync_requested_at = new Date().toISOString();
    }
  }

  const { data, error } = await supabase
    .from('conversations')
    .update(updatePayload)
    .eq('org_id', org)
    .eq('id', conversationId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(inboxUrl({ ...base, error: errorText }));
  }

  revalidatePath('/inbox');
  redirect(inboxUrl(base));
}

const assigneeSchema = z.object({
  org: z.uuid(),
  conversationId: z.uuid(),
  assigneeId: z
    .union([z.literal(''), z.uuid()])
    .transform((value) => (value === '' ? null : value)),
});

export async function setConversationAssignee(formData: FormData): Promise<void> {
  const errorText = 'Zuweisung konnte nicht gespeichert werden.';
  const parsed = assigneeSchema.safeParse({
    org: formData.get('org'),
    conversationId: formData.get('conversationId'),
    assigneeId: textField(formData.get('assigneeId')),
  });
  if (!parsed.success) {
    redirect(inboxUrl(fallbackInboxRedirect(formData, errorText)));
  }
  const { org, conversationId, assigneeId } = parsed.data;
  const base: InboxRedirect = {
    org,
    c: conversationId,
    status: sanitizeFilterStatus(formData.get('filterStatus')),
    channel: sanitizeFilterChannel(formData.get('filterChannel')),
  };

  const supabase = await createSupabaseServerClient();

  if (assigneeId !== null) {
    const { data: member } = await supabase
      .from('org_members')
      .select('user_id')
      .eq('org_id', org)
      .eq('user_id', assigneeId)
      .maybeSingle();
    if (!member) {
      redirect(inboxUrl({ ...base, error: errorText }));
    }
  }

  const { data, error } = await supabase
    .from('conversations')
    .update({ assignee_id: assigneeId })
    .eq('org_id', org)
    .eq('id', conversationId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(inboxUrl({ ...base, error: errorText }));
  }

  revalidatePath('/inbox');
  redirect(inboxUrl(base));
}

const noteSchema = z.object({
  org: z.uuid(),
  conversationId: z.uuid(),
  content: z.string().min(1),
});

export async function addNote(formData: FormData): Promise<void> {
  const errorText = 'Notiz konnte nicht gespeichert werden.';
  const parsed = noteSchema.safeParse({
    org: formData.get('org'),
    conversationId: formData.get('conversationId'),
    content: textField(formData.get('content')),
  });
  if (!parsed.success) {
    redirect(inboxUrl(fallbackInboxRedirect(formData, errorText)));
  }
  const { org, conversationId, content } = parsed.data;
  const base: InboxRedirect = {
    org,
    c: conversationId,
    status: sanitizeFilterStatus(formData.get('filterStatus')),
    channel: sanitizeFilterChannel(formData.get('filterChannel')),
  };

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // the conversation must belong to the submitted org (FK alone ignores RLS)
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id')
    .eq('org_id', org)
    .eq('id', conversationId)
    .maybeSingle();
  if (!conversation) {
    redirect(inboxUrl({ ...base, error: errorText }));
  }

  const { error } = await supabase.from('notes').insert({
    org_id: org,
    conversation_id: conversationId,
    author_id: user.id,
    content,
  });
  if (error) {
    redirect(inboxUrl({ ...base, error: errorText }));
  }

  revalidatePath('/inbox');
  redirect(inboxUrl(base));
}

const contactUpdateSchema = z.object({
  org: z.uuid(),
  conversationId: z.uuid(),
  contactId: z.uuid(),
  name: z.string().max(200),
  phone: z.string().max(50),
});

export async function updateContact(formData: FormData): Promise<void> {
  const errorText = 'Kontakt konnte nicht gespeichert werden.';
  const parsed = contactUpdateSchema.safeParse({
    org: formData.get('org'),
    conversationId: formData.get('conversationId'),
    contactId: formData.get('contactId'),
    name: textField(formData.get('name')),
    phone: textField(formData.get('phone')),
  });
  if (!parsed.success) {
    redirect(inboxUrl(fallbackInboxRedirect(formData, errorText)));
  }
  const { org, conversationId, contactId, name, phone } = parsed.data;
  const base: InboxRedirect = {
    org,
    c: conversationId,
    status: sanitizeFilterStatus(formData.get('filterStatus')),
    channel: sanitizeFilterChannel(formData.get('filterChannel')),
  };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('contacts')
    .update({ name: name === '' ? null : name, phone: phone === '' ? null : phone })
    .eq('org_id', org)
    .eq('id', contactId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(inboxUrl({ ...base, error: errorText }));
  }

  revalidatePath('/inbox');
  redirect(inboxUrl(base));
}

// --- canned responses ------------------------------------------------------------

const cannedResponseSchema = z.object({
  org: z.uuid(),
  shortcut: z.string().regex(/^[a-z0-9-]{2,30}$/),
  content: z.string().min(1),
});

export async function saveCannedResponse(formData: FormData): Promise<void> {
  const parsed = cannedResponseSchema.safeParse({
    org: formData.get('org'),
    shortcut: textField(formData.get('shortcut')),
    content: textField(formData.get('content')),
  });
  if (!parsed.success) {
    redirect(
      cannedResponsesUrl(
        textField(formData.get('org')),
        'Bitte ein Kürzel (a-z, 0-9, "-", 2–30 Zeichen) und einen Text angeben.'
      )
    );
  }
  const { org, shortcut, content } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('canned_responses')
    .insert({ org_id: org, shortcut, content });
  if (error && error.code === '23505') {
    // shortcut already exists for this org → update the content instead
    const { error: updateError } = await supabase
      .from('canned_responses')
      .update({ content })
      .eq('org_id', org)
      .eq('shortcut', shortcut);
    if (updateError) {
      redirect(cannedResponsesUrl(org, 'Textbaustein konnte nicht gespeichert werden.'));
    }
  } else if (error) {
    redirect(cannedResponsesUrl(org, 'Textbaustein konnte nicht gespeichert werden.'));
  }

  revalidatePath('/settings/canned-responses');
  redirect(cannedResponsesUrl(org));
}

const deleteCannedResponseSchema = z.object({
  org: z.uuid(),
  id: z.uuid(),
});

export async function deleteCannedResponse(formData: FormData): Promise<void> {
  const parsed = deleteCannedResponseSchema.safeParse({
    org: formData.get('org'),
    id: formData.get('id'),
  });
  if (!parsed.success) {
    redirect(
      cannedResponsesUrl(
        textField(formData.get('org')),
        'Textbaustein konnte nicht gelöscht werden.'
      )
    );
  }
  const { org, id } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('canned_responses').delete().eq('org_id', org).eq('id', id);
  if (error) {
    redirect(cannedResponsesUrl(org, 'Textbaustein konnte nicht gelöscht werden.'));
  }

  revalidatePath('/settings/canned-responses');
  redirect(cannedResponsesUrl(org));
}

// --- test channel ------------------------------------------------------------------

const testChannelSchema = z.object({
  org: z.uuid(),
  name: z.string().min(2),
});

export async function createTestChannel(formData: FormData): Promise<void> {
  const parsed = testChannelSchema.safeParse({
    org: formData.get('org'),
    name: textField(formData.get('name')),
  });
  if (!parsed.success) {
    redirect(
      channelsUrl(
        textField(formData.get('org')),
        'Bitte einen Namen mit mindestens 2 Zeichen angeben.'
      )
    );
  }
  const { org, name } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('channels')
    .insert({ org_id: org, type: 'chat', name, config: { test: true } });
  if (error) {
    redirect(channelsUrl(org, 'Channel konnte nicht angelegt werden.'));
  }

  revalidatePath('/settings/channels');
  redirect(channelsUrl(org));
}

const ingestSchema = z.object({
  org: z.uuid(),
  channelId: z.uuid(),
  contactEmail: z.email(),
  contactName: z.string().optional(),
  subject: z.string().optional(),
  content: z.string().min(1),
  externalId: z.string().optional(),
});

/**
 * Manual test ingest — a minimal conversation resolver (threading + dedupe via
 * external_id). Serves as the template for the real channel webhooks later.
 */
export async function ingestTestMessage(formData: FormData): Promise<void> {
  const parsed = ingestSchema.safeParse({
    org: formData.get('org'),
    channelId: formData.get('channelId'),
    contactEmail: textField(formData.get('contactEmail')),
    contactName: optionalField(formData.get('contactName')),
    subject: optionalField(formData.get('subject')),
    content: textField(formData.get('content')),
    externalId: optionalField(formData.get('externalId')),
  });
  if (!parsed.success) {
    redirect(
      testChannelUrl(textField(formData.get('org')), {
        error: 'Bitte Channel, E-Mail-Adresse und Nachricht angeben.',
      })
    );
  }
  const { org, channelId, contactEmail, contactName, subject, content, externalId } = parsed.data;

  const supabase = await createSupabaseServerClient();

  // channel must belong to the active org (RLS also hides foreign channels)
  const { data: channelRow } = await supabase
    .from('channels')
    .select('id')
    .eq('org_id', org)
    .eq('id', channelId)
    .maybeSingle();
  if (!channelRow) {
    redirect(testChannelUrl(org, { error: 'Channel wurde nicht gefunden.' }));
  }

  // 0. dedupe BEFORE any side effects — a redelivered external_id must not
  //    create contacts or empty conversations (template for real webhooks)
  if (externalId) {
    const { data: duplicate } = await supabase
      .from('messages')
      .select('id')
      .eq('channel_id', channelId)
      .eq('external_id', externalId)
      .maybeSingle();
    if (duplicate) {
      redirect(
        testChannelUrl(org, {
          notice: 'Duplikat erkannt — Nachricht wurde bereits verarbeitet (Idempotenz).',
        })
      );
    }
  }

  // 1. resolve contact by (org_id, email)
  const email = contactEmail.toLowerCase();
  const { data: contactRows } = await supabase
    .from('contacts')
    .select('id, name')
    .eq('org_id', org)
    .eq('email', email)
    .order('created_at', { ascending: true })
    .limit(1);
  const existingContact = (contactRows ?? [])[0] as { id: string; name: string | null } | undefined;

  let contactId: string;
  if (existingContact) {
    contactId = existingContact.id;
    if (!existingContact.name && contactName) {
      await supabase.from('contacts').update({ name: contactName }).eq('id', existingContact.id);
    }
  } else {
    const { data: insertedContact, error: contactError } = await supabase
      .from('contacts')
      .insert({ org_id: org, email, name: contactName ?? null })
      .select('id')
      .single();
    if (contactError || !insertedContact) {
      redirect(testChannelUrl(org, { error: 'Kontakt konnte nicht angelegt werden.' }));
    }
    contactId = (insertedContact as { id: string }).id;
  }

  // 2. resolve open/pending conversation for (org, channel, contact), newest first
  const { data: conversationRows } = await supabase
    .from('conversations')
    .select('id')
    .eq('org_id', org)
    .eq('channel_id', channelId)
    .eq('contact_id', contactId)
    .in('status', ['open', 'pending'])
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(1);
  const existingConversation = (conversationRows ?? [])[0] as { id: string } | undefined;

  let conversationId: string;
  if (existingConversation) {
    conversationId = existingConversation.id;
  } else {
    const { data: insertedConversation, error: conversationError } = await supabase
      .from('conversations')
      .insert({
        org_id: org,
        channel_id: channelId,
        contact_id: contactId,
        subject: subject ?? null,
        status: 'open',
        mode: 'bot',
      })
      .select('id')
      .single();
    if (conversationError || !insertedConversation) {
      redirect(testChannelUrl(org, { error: 'Konversation konnte nicht angelegt werden.' }));
    }
    conversationId = (insertedConversation as { id: string }).id;
  }

  // 3. insert inbound message (unique (channel_id, external_id) enforces idempotency)
  const { error: messageError } = await supabase.from('messages').insert({
    org_id: org,
    conversation_id: conversationId,
    channel_id: channelId,
    direction: 'in',
    sender_type: 'contact',
    content,
    content_type: 'text',
    external_id: externalId ?? null,
    processing_state: 'pending',
  });
  if (messageError) {
    if (messageError.code === '23505') {
      redirect(
        testChannelUrl(org, {
          notice: 'Duplikat erkannt — Nachricht wurde bereits verarbeitet (Idempotenz).',
        })
      );
    }
    redirect(testChannelUrl(org, { error: 'Nachricht konnte nicht eingespeist werden.' }));
  }

  revalidatePath('/inbox');
  revalidatePath('/test-channel');
  redirect(testChannelUrl(org, { notice: 'Nachricht eingespeist.' }));
}

// --- AI suggested replies (Phase 4 — drafts, never auto-sent) -----------------

type ReplyOutcome = { ok: true } | { ok: false; error: string };

/**
 * Persists an outbound agent message and, for inbound-email channels, delivers
 * it via Resend (recording the outcome on the message). Mirrors sendReply's
 * delivery path so accepting/editing a draft reaches the customer the same way.
 * Never logs message content or recipient addresses (§7).
 */
async function sendAgentReply(
  supabase: SupabaseClient,
  org: string,
  conversationId: string,
  content: string
): Promise<ReplyOutcome> {
  const { data } = await supabase
    .from('conversations')
    .select('id, channel_id')
    .eq('org_id', org)
    .eq('id', conversationId)
    .maybeSingle();
  const conversation = data as { id: string; channel_id: string } | null;
  if (!conversation) {
    return { ok: false, error: 'Konversation wurde nicht gefunden.' };
  }

  const { data: insertedRow, error } = await supabase
    .from('messages')
    .insert({
      org_id: org,
      conversation_id: conversationId,
      channel_id: conversation.channel_id,
      direction: 'out',
      sender_type: 'agent',
      content,
      content_type: 'text',
      processing_state: null,
    })
    .select('id')
    .single();
  if (error || !insertedRow) {
    return { ok: false, error: 'Antwort konnte nicht gespeichert werden.' };
  }
  const messageId = (insertedRow as { id: string }).id;

  const { data: channelRow } = await supabase
    .from('channels')
    .select('type, config')
    .eq('org_id', org)
    .eq('id', conversation.channel_id)
    .maybeSingle();
  const channel = channelRow as { type: string; config: { mode?: unknown } } | null;
  const isInboundEmail = channel?.type === 'email' && channel.config.mode === 'inbound';

  if (isInboundEmail) {
    const admin = createSupabaseAdminClient();
    const result = admin
      ? await deliverOutboundEmail(admin, {
          conversationId,
          orgId: org,
          channelId: conversation.channel_id,
          content,
        })
      : ({ ok: false, error: 'E-Mail-Versand ist serverseitig nicht konfiguriert.' } as const);

    if (!result.ok) {
      await supabase
        .from('messages')
        .update({ metadata: { delivery: { failed: true, error: result.error } } })
        .eq('org_id', org)
        .eq('id', messageId);
      return {
        ok: false,
        error: `Antwort gespeichert, aber E-Mail-Versand fehlgeschlagen: ${result.error}`,
      };
    }

    await supabase
      .from('messages')
      .update({ metadata: { email: { message_id: result.messageId } } })
      .eq('org_id', org)
      .eq('id', messageId);
  } else if (channel?.type === 'whatsapp') {
    const admin = createSupabaseAdminClient();
    const result = admin
      ? await deliverOutboundWhatsApp(admin, {
          conversationId,
          orgId: org,
          channelId: conversation.channel_id,
          content,
        })
      : ({ ok: false, error: 'WhatsApp-Versand ist serverseitig nicht konfiguriert.' } as const);

    if (!result.ok) {
      await supabase
        .from('messages')
        .update({ metadata: { delivery: { failed: true, error: result.error } } })
        .eq('org_id', org)
        .eq('id', messageId);
      return {
        ok: false,
        error: `Antwort gespeichert, aber WhatsApp-Versand fehlgeschlagen: ${result.error}`,
      };
    }

    await supabase
      .from('messages')
      .update({ metadata: { whatsapp: { message_sid: result.externalId } } })
      .eq('org_id', org)
      .eq('id', messageId);
  }

  return { ok: true };
}

// --- Phase 5: handoff (take over / return to bot / request draft) -------------

const handoffActionSchema = z.object({
  org: z.uuid(),
  conversationId: z.uuid(),
});

/**
 * „Übernehmen" (§6 trigger #4): the agent takes the conversation off the bot.
 * Sets mode='human', status='pending', assigns it to the acting agent and
 * records a manual handoff_event. While mode='human' the worker stays silent.
 */
export async function takeOverConversation(formData: FormData): Promise<void> {
  const errorText = 'Konversation konnte nicht übernommen werden.';
  const parsed = handoffActionSchema.safeParse({
    org: formData.get('org'),
    conversationId: formData.get('conversationId'),
  });
  if (!parsed.success) {
    redirect(inboxUrl(fallbackInboxRedirect(formData, errorText)));
  }
  const { org, conversationId } = parsed.data;
  const base: InboxRedirect = {
    org,
    c: conversationId,
    status: sanitizeFilterStatus(formData.get('filterStatus')),
    channel: sanitizeFilterChannel(formData.get('filterChannel')),
  };

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data, error } = await supabase
    .from('conversations')
    .update({ mode: 'human', status: 'pending', assignee_id: user.id })
    .eq('org_id', org)
    .eq('id', conversationId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(inboxUrl({ ...base, error: errorText }));
  }

  // record the manual handoff (triggered_by = acting agent, §6)
  await supabase.from('handoff_events').insert({
    org_id: org,
    conversation_id: conversationId,
    reason: 'manual',
    triggered_by: user.id,
  });

  revalidatePath('/inbox');
  redirect(inboxUrl({ ...base, notice: 'Konversation übernommen — der Bot pausiert.' }));
}

/** „An Bot zurückgeben": hands control back to the bot (mode='bot'); status stays. */
export async function returnToBot(formData: FormData): Promise<void> {
  const errorText = 'Konversation konnte nicht an den Bot zurückgegeben werden.';
  const parsed = handoffActionSchema.safeParse({
    org: formData.get('org'),
    conversationId: formData.get('conversationId'),
  });
  if (!parsed.success) {
    redirect(inboxUrl(fallbackInboxRedirect(formData, errorText)));
  }
  const { org, conversationId } = parsed.data;
  const base: InboxRedirect = {
    org,
    c: conversationId,
    status: sanitizeFilterStatus(formData.get('filterStatus')),
    channel: sanitizeFilterChannel(formData.get('filterChannel')),
  };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('conversations')
    .update({ mode: 'bot' })
    .eq('org_id', org)
    .eq('id', conversationId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(inboxUrl({ ...base, error: errorText }));
  }

  revalidatePath('/inbox');
  redirect(inboxUrl({ ...base, notice: 'An den Bot zurückgegeben.' }));
}

/**
 * „Entwurf anfordern" (§6): even while mode='human', re-queue the newest inbound
 * message with metadata.force_draft so the worker generates a draft without
 * auto-sending. The worker clears force_draft after the draft is stored.
 */
export async function requestDraft(formData: FormData): Promise<void> {
  const errorText = 'Entwurf konnte nicht angefordert werden.';
  const parsed = handoffActionSchema.safeParse({
    org: formData.get('org'),
    conversationId: formData.get('conversationId'),
  });
  if (!parsed.success) {
    redirect(inboxUrl(fallbackInboxRedirect(formData, errorText)));
  }
  const { org, conversationId } = parsed.data;
  const base: InboxRedirect = {
    org,
    c: conversationId,
    status: sanitizeFilterStatus(formData.get('filterStatus')),
    channel: sanitizeFilterChannel(formData.get('filterChannel')),
  };

  const supabase = await createSupabaseServerClient();

  // the conversation must belong to the submitted org (RLS also enforces this)
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id')
    .eq('org_id', org)
    .eq('id', conversationId)
    .maybeSingle();
  if (!conversation) {
    redirect(inboxUrl({ ...base, error: errorText }));
  }

  // newest inbound message of this conversation → re-queue it for the worker
  const { data: rows } = await supabase
    .from('messages')
    .select('id, metadata')
    .eq('org_id', org)
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(1);
  const message = (rows ?? [])[0] as
    { id: string; metadata: Record<string, unknown> | null } | undefined;
  if (!message) {
    redirect(
      inboxUrl({ ...base, error: 'Keine eingehende Nachricht für einen Entwurf gefunden.' })
    );
  }

  const mergedMetadata = { ...(message.metadata ?? {}), force_draft: true };
  const { error } = await supabase
    .from('messages')
    .update({ processing_state: 'pending', metadata: mergedMetadata })
    .eq('org_id', org)
    .eq('id', message.id);
  if (error) {
    redirect(inboxUrl({ ...base, error: errorText }));
  }

  revalidatePath('/inbox');
  redirect(inboxUrl({ ...base, notice: 'Entwurf wird erstellt …' }));
}

const draftActionSchema = z.object({
  org: z.uuid(),
  conversationId: z.uuid(),
  draftId: z.uuid(),
});

const editDraftSchema = draftActionSchema.extend({
  content: z.string().min(1),
});

/**
 * Übernehmen: claims the pending draft (pending→accepted in one conditional
 * update) BEFORE sending, so a double click / race can never send it twice —
 * only the request that flips exactly one row proceeds to deliver.
 */
export async function acceptDraft(formData: FormData): Promise<void> {
  const errorText = 'Vorschlag konnte nicht übernommen werden.';
  const parsed = draftActionSchema.safeParse({
    org: formData.get('org'),
    conversationId: formData.get('conversationId'),
    draftId: formData.get('draftId'),
  });
  if (!parsed.success) {
    redirect(inboxUrl(fallbackInboxRedirect(formData, errorText)));
  }
  const { org, conversationId, draftId } = parsed.data;
  const base: InboxRedirect = {
    org,
    c: conversationId,
    status: sanitizeFilterStatus(formData.get('filterStatus')),
    channel: sanitizeFilterChannel(formData.get('filterChannel')),
  };

  const supabase = await createSupabaseServerClient();
  // Claim first: only the row still 'pending' flips, and only for this org.
  const { data: claimed, error: claimError } = await supabase
    .from('ai_drafts')
    .update({ status: 'accepted' })
    .eq('org_id', org)
    .eq('id', draftId)
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')
    .select('id, content');
  const claim = (claimed ?? [])[0] as { id: string; content: string } | undefined;
  if (claimError || !claim) {
    redirect(inboxUrl({ ...base, error: 'Der Vorschlag ist nicht mehr verfügbar.' }));
  }

  const sent = await sendAgentReply(supabase, org, conversationId, claim.content);
  if (!sent.ok) {
    // delivery failed after claiming → release the claim so the agent can retry
    await supabase
      .from('ai_drafts')
      .update({ status: 'pending' })
      .eq('org_id', org)
      .eq('id', draftId)
      .eq('status', 'accepted');
    redirect(inboxUrl({ ...base, error: sent.error }));
  }

  revalidatePath('/inbox');
  redirect(inboxUrl({ ...base, notice: 'Vorschlag gesendet.' }));
}

/** Verwerfen: marks the pending draft discarded without sending anything. */
export async function discardDraft(formData: FormData): Promise<void> {
  const errorText = 'Vorschlag konnte nicht verworfen werden.';
  const parsed = draftActionSchema.safeParse({
    org: formData.get('org'),
    conversationId: formData.get('conversationId'),
    draftId: formData.get('draftId'),
  });
  if (!parsed.success) {
    redirect(inboxUrl(fallbackInboxRedirect(formData, errorText)));
  }
  const { org, conversationId, draftId } = parsed.data;
  const base: InboxRedirect = {
    org,
    c: conversationId,
    status: sanitizeFilterStatus(formData.get('filterStatus')),
    channel: sanitizeFilterChannel(formData.get('filterChannel')),
  };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('ai_drafts')
    .update({ status: 'discarded' })
    .eq('org_id', org)
    .eq('id', draftId)
    .eq('conversation_id', conversationId)
    .eq('status', 'pending');
  if (error) {
    redirect(inboxUrl({ ...base, error: errorText }));
  }

  revalidatePath('/inbox');
  redirect(inboxUrl({ ...base, notice: 'Vorschlag verworfen.' }));
}

/**
 * Bearbeiten: sends the agent-edited draft content and marks the draft edited.
 * Editing happens inline in the SuggestedReply card; the edited text is sent
 * through the same path as a normal agent reply.
 */
export async function markDraftEdited(formData: FormData): Promise<void> {
  const errorText = 'Bearbeitete Antwort konnte nicht gesendet werden.';
  const parsed = editDraftSchema.safeParse({
    org: formData.get('org'),
    conversationId: formData.get('conversationId'),
    draftId: formData.get('draftId'),
    content: textField(formData.get('content')),
  });
  if (!parsed.success) {
    redirect(inboxUrl(fallbackInboxRedirect(formData, errorText)));
  }
  const { org, conversationId, draftId, content } = parsed.data;
  const base: InboxRedirect = {
    org,
    c: conversationId,
    status: sanitizeFilterStatus(formData.get('filterStatus')),
    channel: sanitizeFilterChannel(formData.get('filterChannel')),
  };

  const supabase = await createSupabaseServerClient();
  // Claim first (pending→edited); only the winner of the race sends the edit.
  const { data: claimed, error: claimError } = await supabase
    .from('ai_drafts')
    .update({ status: 'edited' })
    .eq('org_id', org)
    .eq('id', draftId)
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')
    .select('id');
  const claim = (claimed ?? [])[0] as { id: string } | undefined;
  if (claimError || !claim) {
    redirect(inboxUrl({ ...base, error: 'Der Vorschlag ist nicht mehr verfügbar.' }));
  }

  const sent = await sendAgentReply(supabase, org, conversationId, content);
  if (!sent.ok) {
    // delivery failed after claiming → release the claim so the agent can retry
    await supabase
      .from('ai_drafts')
      .update({ status: 'pending' })
      .eq('org_id', org)
      .eq('id', draftId)
      .eq('status', 'edited');
    redirect(inboxUrl({ ...base, error: sent.error }));
  }

  revalidatePath('/inbox');
  redirect(inboxUrl({ ...base, notice: 'Bearbeitete Antwort gesendet.' }));
}

// --- Phase 6: manual HubSpot sync --------------------------------------------

/**
 * „An HubSpot senden" (§11 Phase 6): marks the conversation due for a one-way
 * HubSpot sync by bumping hubspot_sync_requested_at. The worker picks it up and
 * no-ops harmlessly if the org has no active HubSpot integration. User-scoped
 * (RLS restricts to org members); never logs conversation content.
 */
export async function syncToHubspot(formData: FormData): Promise<void> {
  const errorText = 'An HubSpot senden fehlgeschlagen.';
  const parsed = handoffActionSchema.safeParse({
    org: formData.get('org'),
    conversationId: formData.get('conversationId'),
  });
  if (!parsed.success) {
    redirect(inboxUrl(fallbackInboxRedirect(formData, errorText)));
  }
  const { org, conversationId } = parsed.data;
  const base: InboxRedirect = {
    org,
    c: conversationId,
    status: sanitizeFilterStatus(formData.get('filterStatus')),
    channel: sanitizeFilterChannel(formData.get('filterChannel')),
  };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('conversations')
    .update({ hubspot_sync_requested_at: new Date().toISOString() })
    .eq('org_id', org)
    .eq('id', conversationId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(inboxUrl({ ...base, error: errorText }));
  }

  revalidatePath('/inbox');
  redirect(inboxUrl({ ...base, notice: 'Konversation zum HubSpot-Sync vorgemerkt.' }));
}
