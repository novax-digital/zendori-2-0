'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { sendPasswordResetMail } from '@/lib/auth/password-reset';
import { checkRateLimit, clientIpFromHeaders } from '@/lib/rate-limit';

const emailSchema = z.email().max(200);

function back(params: Record<string, string>): never {
  redirect(`/passwort-vergessen?${new URLSearchParams(params).toString()}`);
}

/**
 * "Passwort vergessen" submit. Always ends on the same "check your inbox"
 * state whether or not an account exists (no enumeration); only a malformed
 * address or the per-IP limit produce an error.
 */
export async function requestPasswordReset(formData: FormData): Promise<void> {
  const raw = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const parsed = emailSchema.safeParse(raw);
  if (!parsed.success) {
    back({ error: 'Bitte gib eine gültige E-Mail-Adresse an.' });
  }
  const email = parsed.data;

  const ip = clientIpFromHeaders(await headers());
  if (!(await checkRateLimit('password-reset-ip', ip))) {
    back({ error: 'Zu viele Anfragen. Bitte versuch es in einer Stunde erneut.' });
  }
  // per-address cap: silently skip the mail, the answer stays the same
  if (await checkRateLimit('password-reset-email', email)) {
    await sendPasswordResetMail(email);
  }
  back({ sent: '1' });
}
