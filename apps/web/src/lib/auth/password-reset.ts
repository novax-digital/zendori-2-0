import 'server-only';
import { sendEmail } from '@zendori/channels';
import { createLogger } from '@zendori/core';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { renderZendoriEmail } from '@/lib/team/mail-templates';

// "Passwort vergessen": same mechanics as the team invite (lib/team/invite.ts) —
// a Supabase recovery token from admin.generateLink (which sends nothing by
// itself) in a branded Zendori mail via Resend. The link opens /passwort-neu,
// which redeems the token on submit (verifyOtp) and sets the new password.
// Callers never learn whether an account exists (no enumeration): an unknown
// address simply gets no mail.

const log = createLogger('password-reset');

function appUrl(): string {
  return (process.env.APP_URL ?? 'https://app.zendori.ai').replace(/\/+$/, '');
}

/** Sends the reset mail when an account exists; resolves quietly otherwise. */
export async function sendPasswordResetMail(email: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  const from = process.env.RESEND_FROM;
  if (!admin || !from) {
    log.error({ admin: Boolean(admin), from: Boolean(from) }, 'password reset not configured');
    return;
  }

  const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) {
    // unknown address (404) is the expected case; anything else is logged content-free
    if (error && error.status !== 404) {
      log.warn({ status: error.status, code: error.code }, 'recovery link failed');
    }
    return;
  }

  const link = `${appUrl()}/passwort-neu?token_hash=${encodeURIComponent(tokenHash)}`;
  const { html, text } = renderZendoriEmail({
    preheader: 'Legen Sie jetzt ein neues Passwort für Ihr Zendori-Konto fest.',
    paragraphs: [
      'Wir haben eine Anfrage erhalten, das Passwort für Ihr Zendori-Konto zurückzusetzen.',
      'Über den folgenden Button legen Sie ein neues Passwort fest:',
    ],
    cta: { label: 'Neues Passwort festlegen', url: link },
    finePrint:
      'Der Link ist zeitlich begrenzt gültig und funktioniert nur einmal. Falls Sie die Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren — Ihr Passwort bleibt unverändert.',
    appUrl: appUrl(),
  });
  try {
    await sendEmail({ from, to: email, subject: 'Neues Passwort für Zendori', text, html });
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : 'unknown' }, 'reset mail failed');
  }
}
