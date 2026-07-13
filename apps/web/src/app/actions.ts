'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export async function signIn(formData: FormData) {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  const next = typeof formData.get('next') === 'string' ? String(formData.get('next')) : '/';
  if (!parsed.success) {
    redirect(`/login?error=${encodeURIComponent('Bitte E-Mail und Passwort (min. 8 Zeichen) angeben.')}`);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    redirect(`/login?error=${encodeURIComponent('E-Mail oder Passwort ist falsch.')}`);
  }
  redirect(next.startsWith('/') ? next : '/');
}

export async function signUp(formData: FormData) {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    redirect(
      `/register?error=${encodeURIComponent('Bitte E-Mail und Passwort (min. 8 Zeichen) angeben.')}`
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp(parsed.data);
  if (error) {
    redirect(`/register?error=${encodeURIComponent(error.message)}`);
  }
  if (!data.session) {
    redirect(
      `/login?notice=${encodeURIComponent('Registrierung erfolgreich. Bitte bestätige deine E-Mail-Adresse und melde dich dann an.')}`
    );
  }
  redirect('/');
}

export async function signOut() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}

export async function createOrganization(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim();
  if (name.length < 2) {
    redirect(
      `/onboarding?error=${encodeURIComponent('Bitte einen Organisationsnamen mit mindestens 2 Zeichen angeben.')}`
    );
  }

  const supabase = await createSupabaseServerClient();
  const baseSlug = slugify(name) || 'org';

  // retry once with a random suffix on slug collision
  for (const slug of [baseSlug, `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`]) {
    const { error } = await supabase.from('organizations').insert({ name, slug });
    if (!error) {
      redirect('/');
    }
    if (error.code !== '23505') {
      redirect(`/onboarding?error=${encodeURIComponent('Organisation konnte nicht angelegt werden.')}`);
    }
  }
  redirect(`/onboarding?error=${encodeURIComponent('Organisation konnte nicht angelegt werden.')}`);
}

const inviteSchema = z.object({
  orgId: z.uuid(),
  email: z.email(),
  role: z.enum(['owner', 'agent']),
});

export async function createInvite(formData: FormData) {
  const parsed = inviteSchema.safeParse({
    orgId: formData.get('orgId'),
    email: formData.get('email'),
    role: formData.get('role'),
  });
  if (!parsed.success) {
    redirect(
      `/settings/members?error=${encodeURIComponent('Bitte eine gültige E-Mail-Adresse angeben.')}`
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('invites').insert({
    org_id: parsed.data.orgId,
    email: parsed.data.email.toLowerCase(),
    role: parsed.data.role,
  });
  if (error) {
    redirect(
      `/settings/members?error=${encodeURIComponent('Einladung konnte nicht erstellt werden (nur Owner dürfen einladen).')}`
    );
  }
  revalidatePath('/settings/members');
  redirect('/settings/members');
}

export async function deleteInvite(formData: FormData) {
  const id = String(formData.get('id') ?? '');
  const supabase = await createSupabaseServerClient();
  await supabase.from('invites').delete().eq('id', id);
  revalidatePath('/settings/members');
  redirect('/settings/members');
}

export async function acceptInvite(formData: FormData) {
  const token = String(formData.get('token') ?? '');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('accept_invite', { p_token: token });
  if (error) {
    redirect(
      `/invite/${encodeURIComponent(token)}?error=${encodeURIComponent('Einladung konnte nicht angenommen werden. Sie ist abgelaufen oder für eine andere E-Mail-Adresse ausgestellt.')}`
    );
  }
  redirect('/');
}
