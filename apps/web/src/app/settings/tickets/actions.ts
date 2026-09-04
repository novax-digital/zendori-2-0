'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isMissingColumnError, ticketIdFormatSchema } from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function settingsUrl(org: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/settings/tickets?${params.toString()}`;
}

/**
 * Persists the ticket numbering settings (0030). The RLS policy
 * org_settings_update restricts writes to owner/admin — a zero-row update is
 * surfaced as the owner hint (settings/ai pattern). The start number only
 * matters before the first ticket; once a counter row exists it is ignored.
 */
export async function saveTicketSettings(formData: FormData): Promise<void> {
  const org = textField(formData.get('org'));
  if (!z.uuid().safeParse(org).success) redirect('/settings/tickets');

  const format = ticketIdFormatSchema.safeParse(textField(formData.get('ticketIdFormat')));
  if (!format.success) {
    redirect(settingsUrl(org, { error: format.error.issues[0]?.message ?? 'Ungültiges Format.' }));
  }
  const startRaw = textField(formData.get('ticketNumberStart'));
  const start = startRaw === '' ? null : z.coerce.number().int().min(1).max(1_000_000_000).safeParse(startRaw);
  if (start && !start.success) {
    redirect(settingsUrl(org, { error: 'Die Startnummer muss eine ganze Zahl ab 1 sein.' }));
  }

  const supabase = await createSupabaseServerClient();
  const { data: counter } = await supabase
    .from('ticket_counters')
    .select('org_id')
    .eq('org_id', org)
    .maybeSingle();
  const patch: Record<string, unknown> = { ticket_id_format: format.data };
  if (start && !counter) patch.ticket_number_start = start.data;

  const { data, error } = await supabase
    .from('org_settings')
    .update(patch)
    .eq('org_id', org)
    .select('org_id');
  if (error) {
    redirect(
      settingsUrl(org, {
        error: isMissingColumnError(error)
          ? 'Tickets sind noch nicht verfügbar (Migration 0030 ausstehend).'
          : 'Einstellungen konnten nicht gespeichert werden.',
      })
    );
  }
  if (!data || data.length === 0) {
    redirect(settingsUrl(org, { error: 'Nur Inhaber und Admins können das Ticket-Format ändern.' }));
  }
  revalidatePath('/settings/tickets');
  redirect(settingsUrl(org, { notice: 'Ticket-Einstellungen gespeichert.' }));
}
