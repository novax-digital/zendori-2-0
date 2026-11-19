'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { validateDemoLead } from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

// Internal demo (Demo-Anruf, 0032): platform admins start a demo call WITHOUT
// the e-mail double opt-in — e.g. live in a customer presentation. Consent is
// given verbally by the person being called; the checkbox documents that the
// presenter asked. No per-number/daily caps here: repeated calls to the same
// number are exactly what a presentation needs.

function text(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

// The start form lives in a drawer (?panel=new): an error redirects back WITH
// the panel so the drawer stays open, a success without it.
function demoUrl(message?: { error?: string; notice?: string }, panel?: 'new'): string {
  const params = new URLSearchParams();
  if (panel) params.set('panel', panel);
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `/admin/demo?${qs}` : '/admin/demo';
}

export async function startAdminDemo(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  if (formData.get('consent') !== 'on') {
    redirect(demoUrl({ error: 'Bitte bestätigen, dass die angerufene Person einverstanden ist.' }, 'new'));
  }
  const validation = validateDemoLead(
    {
      company: text(formData.get('company')),
      contactName: text(formData.get('contactName')),
      email: text(formData.get('email')),
      phone: text(formData.get('phone')),
      websiteUrl: text(formData.get('websiteUrl')),
      prompt: text(formData.get('prompt')),
    },
    { requireEmail: false }
  );
  if (!validation.ok) {
    redirect(demoUrl({ error: Object.values(validation.errors).join(' ') }, 'new'));
  }
  const lead = validation.lead;

  const supabase = createSupabaseAdminClient();
  if (!supabase) redirect(demoUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }, 'new'));
  const { error } = await supabase.from('demo_calls').insert({
    source: 'admin',
    company_name: lead.company,
    contact_name: lead.contactName,
    email: lead.email,
    phone_e164: lead.phoneE164,
    website_url: lead.websiteUrl,
    prompt: lead.prompt,
    requested_by: admin.userId,
    status: 'queued',
  });
  if (error) {
    redirect(demoUrl({ error: 'Der Demo-Anruf konnte nicht angelegt werden.' }, 'new'));
  }
  revalidatePath('/admin/demo');
  redirect(demoUrl({ notice: 'Demo-Anruf gestartet – das Telefon klingelt in wenigen Sekunden.' }));
}

const idSchema = z.uuid();

/** Calls the same lead again (new row, same data) — e.g. "nochmal, bitte". */
export async function redialDemoCall(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const id = idSchema.safeParse(formData.get('id'));
  if (!id.success) redirect(demoUrl({ error: 'Ungültige Anfrage.' }));
  const supabase = createSupabaseAdminClient();
  if (!supabase) redirect(demoUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { data } = await supabase
    .from('demo_calls')
    .select('company_name, contact_name, email, phone_e164, website_url, website_summary, prompt')
    .eq('id', id.data)
    .maybeSingle();
  const row = data as {
    company_name: string;
    contact_name: string;
    email: string | null;
    phone_e164: string;
    website_url: string | null;
    website_summary: string | null;
    prompt: string;
  } | null;
  if (!row) redirect(demoUrl({ error: 'Demo-Anruf nicht gefunden.' }));

  const { error } = await supabase.from('demo_calls').insert({
    source: 'admin',
    company_name: row.company_name,
    contact_name: row.contact_name,
    email: row.email,
    phone_e164: row.phone_e164,
    website_url: row.website_url,
    // reuse the summary: the worker skips the website fetch when it is present
    website_summary: row.website_summary,
    prompt: row.prompt,
    requested_by: admin.userId,
    status: 'queued',
  });
  if (error) redirect(demoUrl({ error: 'Der Demo-Anruf konnte nicht angelegt werden.' }));
  revalidatePath('/admin/demo');
  redirect(demoUrl({ notice: 'Erneuter Demo-Anruf gestartet.' }));
}

/** DSGVO: removes a lead including transcript. Running calls cannot be deleted. */
export async function deleteDemoCall(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const id = idSchema.safeParse(formData.get('id'));
  if (!id.success) redirect(demoUrl({ error: 'Ungültige Anfrage.' }));
  const supabase = createSupabaseAdminClient();
  if (!supabase) redirect(demoUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { data, error } = await supabase
    .from('demo_calls')
    .delete()
    .eq('id', id.data)
    .not('status', 'in', '(preparing,dialing,connecting,in_call)')
    .select('id');
  if (error) redirect(demoUrl({ error: 'Löschen fehlgeschlagen.' }));
  if ((data ?? []).length === 0) {
    redirect(demoUrl({ error: 'Laufende Demo-Anrufe können nicht gelöscht werden.' }));
  }
  revalidatePath('/admin/demo');
  redirect(demoUrl({ notice: 'Demo-Anruf gelöscht.' }));
}
