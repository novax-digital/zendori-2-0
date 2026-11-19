'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { normalizeAreaCode, phoneNumberTypeSchema } from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

// Admin → Telefonnummern (0033): platform admins approve a customer's number
// request with one click. The action only flips the row to 'provisioning' —
// the worker (apps/worker/src/numbers/) buys the Twilio number, creates the
// voice channel and registers it at xAI (nothing long-running on Vercel, §4).
// Every transition is a conditional update, so a double click never queues
// twice and a row the worker already claimed is never touched.

const PAGE = '/admin/phone-numbers';

// The order form lives in a drawer (?panel=order&id=<request>): `orderId`
// keeps that drawer open after an input error; everything else returns to the list.
function pageUrl(message?: { error?: string; notice?: string }, orderId?: string): string {
  const params = new URLSearchParams();
  if (orderId) {
    params.set('panel', 'order');
    params.set('id', orderId);
  }
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `${PAGE}?${qs}` : PAGE;
}

function isMissingColumn(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST204' || error?.code === '42703';
}

const MIGRATION_MISSING = 'Migration 0033 ist noch nicht eingespielt.';
const NO_SERVICE_ROLE = 'Service-Role ist serverseitig nicht konfiguriert.';

const orderSchema = z.object({
  id: z.uuid(),
  channelName: z.string().trim().min(1, 'Bitte einen Kanalnamen angeben.').max(120),
  numberType: phoneNumberTypeSchema,
  areaCode: z.string().max(20),
});

/**
 * "Kostenpflichtig bestellen" — from an open request, or again from a failed
 * attempt that bought nothing yet (then type/area code may be corrected).
 */
export async function orderPhoneNumber(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const parsed = orderSchema.safeParse({
    id: formData.get('id'),
    channelName: formData.get('channelName') ?? '',
    numberType: formData.get('numberType'),
    areaCode: formData.get('areaCode') ?? '',
  });
  if (!parsed.success) {
    // only a well-formed id may travel back into the URL
    const rawId = z.uuid().safeParse(formData.get('id'));
    redirect(
      pageUrl(
        { error: parsed.error.issues[0]?.message ?? 'Ungültige Eingabe.' },
        rawId.success ? rawId.data : undefined
      )
    );
  }
  const areaCode = normalizeAreaCode(parsed.data.areaCode);
  if (areaCode === 'invalid') {
    redirect(
      pageUrl(
        { error: 'Ungültige Vorwahl – z. B. 0511 eingeben oder leer lassen.' },
        parsed.data.id
      )
    );
  }

  const supabase = createSupabaseAdminClient();
  if (!supabase) redirect(pageUrl({ error: NO_SERVICE_ROLE }));
  const { data, error } = await supabase
    .from('phone_numbers')
    .update({
      status: 'provisioning',
      channel_name: parsed.data.channelName,
      number_type: parsed.data.numberType,
      area_code: areaCode,
      approved_by: admin.userId,
      approved_at: new Date().toISOString(),
      provision_error: null,
      provision_started_at: null,
    })
    .eq('id', parsed.data.id)
    .in('status', ['requested', 'failed'])
    .is('twilio_phone_number_sid', null)
    .select('id');
  if (error) {
    redirect(pageUrl({ error: isMissingColumn(error) ? MIGRATION_MISSING : 'Bestellung fehlgeschlagen.' }));
  }
  if (!data || data.length === 0) {
    redirect(pageUrl({ error: 'Die Anfrage ist nicht mehr offen (bereits bestellt oder entfernt).' }));
  }
  revalidatePath(PAGE);
  redirect(
    pageUrl({ notice: 'Bestellt – die Nummer wird jetzt automatisch eingerichtet (dauert meist unter einer Minute).' })
  );
}

const idSchema = z.uuid();

/** "Erneut versuchen" after a failure with an already bought number: the worker resumes. */
export async function resumePhoneNumber(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const id = idSchema.safeParse(formData.get('id'));
  if (!id.success) redirect(pageUrl({ error: 'Ungültige Anfrage.' }));
  const supabase = createSupabaseAdminClient();
  if (!supabase) redirect(pageUrl({ error: NO_SERVICE_ROLE }));
  const { data, error } = await supabase
    .from('phone_numbers')
    .update({ status: 'provisioning', provision_error: null, provision_started_at: null })
    .eq('id', id.data)
    .eq('status', 'failed')
    .select('id');
  if (error) {
    redirect(pageUrl({ error: isMissingColumn(error) ? MIGRATION_MISSING : 'Neustart fehlgeschlagen.' }));
  }
  if (!data || data.length === 0) {
    redirect(pageUrl({ error: 'Der Eintrag ist nicht (mehr) fehlgeschlagen.' }));
  }
  revalidatePath(PAGE);
  redirect(pageUrl({ notice: 'Wird fortgesetzt – bereits Erledigtes wird übernommen.' }));
}

/** "Anfrage ablehnen": removes a request that has not bought anything. */
export async function rejectPhoneNumberRequest(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const id = idSchema.safeParse(formData.get('id'));
  if (!id.success) redirect(pageUrl({ error: 'Ungültige Anfrage.' }));
  const supabase = createSupabaseAdminClient();
  if (!supabase) redirect(pageUrl({ error: NO_SERVICE_ROLE }));
  const { data, error } = await supabase
    .from('phone_numbers')
    .delete()
    .eq('id', id.data)
    .in('status', ['requested', 'failed'])
    .is('twilio_phone_number_sid', null)
    .select('id');
  if (error) redirect(pageUrl({ error: 'Ablehnen fehlgeschlagen.' }));
  if (!data || data.length === 0) {
    redirect(pageUrl({ error: 'Die Anfrage kann nicht mehr abgelehnt werden (bereits in Bearbeitung).' }));
  }
  revalidatePath(PAGE);
  redirect(pageUrl({ notice: 'Anfrage abgelehnt und entfernt.' }));
}
