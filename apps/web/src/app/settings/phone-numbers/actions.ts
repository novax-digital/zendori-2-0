'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { phoneNumberTypeSchema } from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numbersUrl(org: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/settings/phone-numbers?${params.toString()}`;
}

// --- request a new number ---------------------------------------------------------

const requestSchema = z.object({
  org: z.uuid(),
  numberType: phoneNumberTypeSchema,
  desiredRegion: z.string().max(120),
  note: z.string().max(500),
});

/**
 * Files a phone-number REQUEST (0016). RLS restricts the insert to owners and
 * to status='requested' rows without provider ids — the operator fulfills the
 * request via the provisioning script, which flips the row to 'active'.
 */
export async function requestPhoneNumber(formData: FormData): Promise<void> {
  const parsed = requestSchema.safeParse({
    org: formData.get('org'),
    numberType: textField(formData.get('numberType')),
    desiredRegion: textField(formData.get('desiredRegion')),
    note: textField(formData.get('note')),
  });
  if (!parsed.success) {
    redirect(
      numbersUrl(textField(formData.get('org')), {
        error: 'Bitte Nummern-Typ wählen (Wunschregion/Notiz optional, max. 120/500 Zeichen).',
      })
    );
  }
  const { org, numberType, desiredRegion, note } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { error } = await supabase.from('phone_numbers').insert({
    org_id: org,
    number_type: numberType,
    status: 'requested',
    desired_region: desiredRegion === '' ? null : desiredRegion,
    note: note === '' ? null : note,
    requested_by: user.id,
  });
  if (error) {
    // RLS rejects non-owners — the likeliest failure here.
    redirect(
      numbersUrl(org, { error: 'Anfrage konnte nicht angelegt werden (nur Inhaber).' })
    );
  }

  revalidatePath('/settings/phone-numbers');
  redirect(
    numbersUrl(org, {
      notice:
        'Nummern-Anfrage eingereicht. Zendori richtet die Nummer ein und meldet sich — sie erscheint dann hier als aktiv.',
    })
  );
}

// --- withdraw an open request -----------------------------------------------------

const withdrawSchema = z.object({ org: z.uuid(), id: z.uuid() });

export async function withdrawPhoneNumberRequest(formData: FormData): Promise<void> {
  const parsed = withdrawSchema.safeParse({
    org: formData.get('org'),
    id: formData.get('id'),
  });
  if (!parsed.success) {
    redirect(
      numbersUrl(textField(formData.get('org')), {
        error: 'Anfrage konnte nicht zurückgezogen werden.',
      })
    );
  }
  const { org, id } = parsed.data;

  const supabase = await createSupabaseServerClient();
  // RLS allows deleting only status='requested' rows of the own org (owners).
  const { data, error } = await supabase
    .from('phone_numbers')
    .delete()
    .eq('org_id', org)
    .eq('id', id)
    .eq('status', 'requested')
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(numbersUrl(org, { error: 'Anfrage konnte nicht zurückgezogen werden.' }));
  }

  revalidatePath('/settings/phone-numbers');
  redirect(numbersUrl(org, { notice: 'Anfrage zurückgezogen.' }));
}
