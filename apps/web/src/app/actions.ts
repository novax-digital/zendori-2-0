'use server';

import { redirect } from 'next/navigation';
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
    redirect(
      `/login?error=${encodeURIComponent('Bitte E-Mail und Passwort (min. 8 Zeichen) angeben.')}`
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    redirect(`/login?error=${encodeURIComponent('E-Mail oder Passwort ist falsch.')}`);
  }
  // only same-origin paths — '//evil.example' would be an open redirect
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
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
      redirect(
        `/onboarding?error=${encodeURIComponent('Organisation konnte nicht angelegt werden.')}`
      );
    }
  }
  redirect(`/onboarding?error=${encodeURIComponent('Organisation konnte nicht angelegt werden.')}`);
}

// Member/user creation moved to admin flows (no public self-registration). Org
// owners add their team via createMember (settings/members); Zendori superadmins
// manage all owners + create accounts in /admin. See members/actions.ts.
