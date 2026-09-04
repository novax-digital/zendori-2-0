'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  conversationPrioritySchema,
  requestTicketHubspotSync,
  ticketStatusSchema,
} from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMemberAccess, hasTicketEdit } from '@/lib/access';
import { isAdminRole } from '@zendori/core';

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
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('tickets')
    .update({ status: status.data })
    .eq('org_id', org)
    .eq('id', ticketId)
    .select('id, channel_id, hubspot_ticket_id');
  if (error || !data || data.length === 0) {
    redirect(ticketUrl(org, ticketId, { error: 'Status konnte nicht gespeichert werden.' }));
  }
  if (status.data === 'resolved') {
    // Phase 11b: "Erledigt" moves the HubSpot ticket to the resolved stage —
    // when it is already in HubSpot, or the ticket-stream rule covers the channel.
    const row = data[0] as { channel_id: string; hubspot_ticket_id: string | null };
    await requestTicketHubspotSync(supabase, {
      orgId: org,
      channelId: row.channel_id,
      ticketId,
      alreadySynced: row.hubspot_ticket_id !== null,
    });
  }
  revalidatePath('/tickets');
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath('/inbox');
  redirect(ticketUrl(org, ticketId, { notice: 'Status aktualisiert.' }));
}

/** „An HubSpot senden" on the ticket (Phase 11b): arms the ticket-stream sync regardless of rules. */
export async function syncTicketToHubspot(formData: FormData): Promise<void> {
  const { org, ticketId } = await guard(formData);
  const supabase = await createSupabaseServerClient();
  const { data: integration } = await supabase
    .from('integrations')
    .select('id, is_active, config')
    .eq('org_id', org)
    .eq('type', 'hubspot')
    .maybeSingle();
  if (!integration) redirect(ticketUrl(org, ticketId, { error: 'HubSpot ist nicht verbunden.' }));
  const config = ((integration as { config?: unknown }).config ?? {}) as Record<string, unknown>;
  if (!config.tickets || typeof config.tickets !== 'object') {
    redirect(
      ticketUrl(org, ticketId, {
        error: 'Für Tickets ist keine HubSpot-Pipeline konfiguriert (Einstellungen → Integrationen).',
      })
    );
  }
  await patchTicket(
    org,
    ticketId,
    { hubspot_sync_requested_at: new Date().toISOString() },
    (integration as { is_active?: boolean }).is_active
      ? 'Ticket zum HubSpot-Sync vorgemerkt.'
      : 'Vorgemerkt — die Integration ist deaktiviert, der Sync läuft erst nach dem Aktivieren.',
    'HubSpot-Sync konnte nicht vorgemerkt werden.'
  );
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

/**
 * Delete a ticket (owner/admin — the tickets_delete RLS policy is the hard
 * gate, the role check here only produces the right German message). The
 * conversation and its messages stay; ticket_events cascade; a HubSpot ticket
 * created from it stays in HubSpot (same convention as channels/agents).
 */
export async function deleteTicket(formData: FormData): Promise<void> {
  const parsed = baseSchema.safeParse({
    org: formData.get('org'),
    ticketId: formData.get('ticketId'),
  });
  if (!parsed.success) redirect(ticketsUrl(textField(formData.get('org')), 'Ticket wurde nicht gefunden.'));
  const { org, ticketId } = parsed.data;
  const access = await getMemberAccess(org);
  if (!access || !isAdminRole(access.role)) {
    redirect(ticketUrl(org, ticketId, { error: 'Nur Inhaber und Admins können Tickets löschen.' }));
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('tickets')
    .delete()
    .eq('org_id', org)
    .eq('id', ticketId)
    .select('id, display_id');
  if (error || !data || data.length === 0) {
    redirect(ticketUrl(org, ticketId, { error: 'Ticket konnte nicht gelöscht werden.' }));
  }
  const displayId = (data[0] as { display_id?: string }).display_id ?? '';
  revalidatePath('/tickets');
  revalidatePath('/inbox');
  const params = new URLSearchParams({ org, notice: `Ticket ${displayId} gelöscht.` });
  redirect(`/tickets?${params.toString()}`);
}
