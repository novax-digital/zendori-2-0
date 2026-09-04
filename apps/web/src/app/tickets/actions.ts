'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { conversationPrioritySchema, ticketStatusSchema } from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { hasTicketEdit } from '@/lib/access';

// Server actions of the ticket detail page (Phase 11). Every mutation is
// guarded by hasTicketEdit (tickets edit + channel scope) and scoped by
// org_id + ticket id; the 0030 trigger additionally refuses identity/HubSpot
// column writes. Redirects carry ?notice/?error like the inbox actions.

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function ticketUrl(org: string, ticketId: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/tickets/${ticketId}?${params.toString()}`;
}

function ticketsUrl(org: string, error: string): string {
  const params = new URLSearchParams({ org, error });
  return `/tickets?${params.toString()}`;
}

const baseSchema = z.object({ org: z.uuid(), ticketId: z.uuid() });

async function guard(formData: FormData): Promise<{ org: string; ticketId: string }> {
  const parsed = baseSchema.safeParse({
    org: formData.get('org'),
    ticketId: formData.get('ticketId'),
  });
  if (!parsed.success) redirect(ticketsUrl(textField(formData.get('org')), 'Ticket wurde nicht gefunden.'));
  if (!(await hasTicketEdit(parsed.data.org, parsed.data.ticketId))) {
    redirect(ticketUrl(parsed.data.org, parsed.data.ticketId, { error: 'Keine Berechtigung.' }));
  }
  return parsed.data;
}

async function patchTicket(
  org: string,
  ticketId: string,
  patch: Record<string, unknown>,
  notice: string,
  errorText: string
): Promise<never> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('tickets')
    .update(patch)
    .eq('org_id', org)
    .eq('id', ticketId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(ticketUrl(org, ticketId, { error: errorText }));
  }
  revalidatePath('/tickets');
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath('/inbox');
  redirect(ticketUrl(org, ticketId, { notice }));
}

export async function setTicketStatus(formData: FormData): Promise<void> {
  const { org, ticketId } = await guard(formData);
  const status = ticketStatusSchema.safeParse(textField(formData.get('status')));
  if (!status.success) redirect(ticketUrl(org, ticketId, { error: 'Ungültiger Status.' }));
  await patchTicket(org, ticketId, { status: status.data }, 'Status aktualisiert.', 'Status konnte nicht gespeichert werden.');
}

export async function setTicketPriority(formData: FormData): Promise<void> {
  const { org, ticketId } = await guard(formData);
  const priority = conversationPrioritySchema.safeParse(textField(formData.get('priority')));
  if (!priority.success) redirect(ticketUrl(org, ticketId, { error: 'Ungültige Priorität.' }));
  await patchTicket(org, ticketId, { priority: priority.data }, 'Priorität aktualisiert.', 'Priorität konnte nicht gespeichert werden.');
}

export async function setTicketAssignee(formData: FormData): Promise<void> {
  const { org, ticketId } = await guard(formData);
  const raw = textField(formData.get('assigneeId'));
  let assigneeId: string | null = null;
  if (raw !== '') {
    if (!z.uuid().safeParse(raw).success) {
      redirect(ticketUrl(org, ticketId, { error: 'Ungültige Zuweisung.' }));
    }
    // only members of THIS org may be assigned
    const supabase = await createSupabaseServerClient();
    const { data: member } = await supabase
      .from('org_members')
      .select('user_id')
      .eq('org_id', org)
      .eq('user_id', raw)
      .maybeSingle();
    if (!member) redirect(ticketUrl(org, ticketId, { error: 'Diese Person gehört nicht zur Organisation.' }));
    assigneeId = raw;
  }
  await patchTicket(org, ticketId, { assignee_id: assigneeId }, 'Zuweisung aktualisiert.', 'Zuweisung konnte nicht gespeichert werden.');
}

const fieldsSchema = z.object({
  subject: z.string().min(1).max(200),
  description: z.string().max(4000),
});

export async function updateTicketFields(formData: FormData): Promise<void> {
  const { org, ticketId } = await guard(formData);
  const parsed = fieldsSchema.safeParse({
    subject: textField(formData.get('subject')),
    description: textField(formData.get('description')),
  });
  if (!parsed.success) {
    redirect(ticketUrl(org, ticketId, { error: 'Bitte Betreff (1–200 Zeichen) und Beschreibung (max. 4000 Zeichen) prüfen.' }));
  }
  await patchTicket(
    org,
    ticketId,
    { subject: parsed.data.subject, description: parsed.data.description === '' ? null : parsed.data.description },
    'Anliegen gespeichert.',
    'Anliegen konnte nicht gespeichert werden.'
  );
}

export async function addTicketNote(formData: FormData): Promise<void> {
  const { org, ticketId } = await guard(formData);
  const content = textField(formData.get('content'));
  if (content.length === 0 || content.length > 4000) {
    redirect(ticketUrl(org, ticketId, { error: 'Bitte eine Notiz (max. 4000 Zeichen) eingeben.' }));
  }
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: ticket } = await supabase
    .from('tickets')
    .select('conversation_id')
    .eq('org_id', org)
    .eq('id', ticketId)
    .maybeSingle();
  const conversationId = (ticket as { conversation_id?: string } | null)?.conversation_id;
  if (!conversationId) redirect(ticketUrl(org, ticketId, { error: 'Ticket wurde nicht gefunden.' }));
  // notes live on the conversation (shared with the inbox); the ticket timeline
  // only records that a note was added (content-free)
  const { error } = await supabase.from('notes').insert({
    org_id: org,
    conversation_id: conversationId,
    author_id: user.id,
    content,
  });
  if (error) redirect(ticketUrl(org, ticketId, { error: 'Notiz konnte nicht gespeichert werden.' }));
  await supabase.from('ticket_events').insert({
    org_id: org,
    ticket_id: ticketId,
    kind: 'note',
    actor_id: user.id,
    details: {},
  });
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath('/inbox');
  redirect(ticketUrl(org, ticketId, { notice: 'Notiz gespeichert.' }));
}
