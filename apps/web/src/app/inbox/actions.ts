'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { conversationStatusSchema } from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';

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

  const { error } = await supabase.from('messages').insert({
    org_id: org,
    conversation_id: conversationId,
    channel_id: conversation.channel_id,
    direction: 'out',
    sender_type: 'agent',
    content,
    content_type: 'text',
    processing_state: null,
  });
  if (error) {
    return { error: errorText };
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
  const { data, error } = await supabase
    .from('conversations')
    .update({ status })
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
