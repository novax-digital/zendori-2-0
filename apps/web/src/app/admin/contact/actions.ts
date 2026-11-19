'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { contactStatusSchema } from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

// Kontaktanfragen (0034): platform admins work through the messages from the
// contact form on zendori.ai — set a status, keep an internal note, delete.
// All writes go through the service role after requirePlatformAdmin.

const idSchema = z.uuid();

function text(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

/** Back to the list (optionally with the request's drawer open) + a message. */
function contactUrl(
  message?: { error?: string; notice?: string },
  open?: { id: string; filter?: string }
): string {
  const params = new URLSearchParams();
  if (open?.filter) params.set('status', open.filter);
  if (open) {
    params.set('panel', 'request');
    params.set('id', open.id);
  }
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `/admin/contact?${qs}` : '/admin/contact';
}

/** Status + internal note of one request. */
export async function updateContactRequest(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const id = idSchema.safeParse(formData.get('id'));
  if (!id.success) redirect(contactUrl({ error: 'Ungültige Anfrage.' }));
  const status = contactStatusSchema.safeParse(formData.get('status'));
  const note = text(formData.get('note')).trim();
  const open = { id: id.data };
  if (!status.success) redirect(contactUrl({ error: 'Bitte einen Status wählen.' }, open));
  if (note.length > 2000) {
    redirect(contactUrl({ error: 'Die Notiz ist zu lang (maximal 2000 Zeichen).' }, open));
  }
  const supabase = createSupabaseAdminClient();
  if (!supabase) redirect(contactUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const handled = status.data !== 'new';
  const { data, error } = await supabase
    .from('contact_requests')
    .update({
      status: status.data,
      note,
      handled_by: handled ? admin.userId : null,
      handled_at: handled ? new Date().toISOString() : null,
    })
    .eq('id', id.data)
    .select('id');
  if (error) redirect(contactUrl({ error: 'Speichern fehlgeschlagen.' }, open));
  if ((data ?? []).length === 0) redirect(contactUrl({ error: 'Die Anfrage gibt es nicht mehr.' }));
  revalidatePath('/admin/contact');
  redirect(contactUrl({ notice: 'Gespeichert.' }));
}

/** DSGVO: removes a request completely. */
export async function deleteContactRequest(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const id = idSchema.safeParse(formData.get('id'));
  if (!id.success) redirect(contactUrl({ error: 'Ungültige Anfrage.' }));
  const supabase = createSupabaseAdminClient();
  if (!supabase) redirect(contactUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { error } = await supabase.from('contact_requests').delete().eq('id', id.data);
  if (error) redirect(contactUrl({ error: 'Löschen fehlgeschlagen.' }));
  revalidatePath('/admin/contact');
  redirect(contactUrl({ notice: 'Kontaktanfrage gelöscht.' }));
}
