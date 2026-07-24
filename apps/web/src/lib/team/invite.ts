import 'server-only';
import { sendEmail } from '@zendori/channels';
import type { SupabaseClient } from '@zendori/core';

// Team invitation plumbing (0024, App-Control pattern): the account is created
// WITHOUT a password (email pre-confirmed), and the invite e-mail carries a
// Supabase recovery link — the invitee opens /invite/passwort, the page redeems
// the token (verifyOtp) and sets their password. Existing accounts (multi-org)
// are NOT recreated: they just gain the membership and get a plain
// "added to team" mail instead of a password link.

/** Resolve an auth user id by e-mail via paginated listUsers (tiny user base). */
export async function findUserIdByEmail(
  admin: SupabaseClient,
  email: string
): Promise<string | null> {
  const needle = email.trim().toLowerCase();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === needle);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

/**
 * Ensure an auth user exists for the invitee. Returns the user id plus whether
 * the account is brand-new (⇒ password-setup mail) or existing (⇒ added mail).
 */
export async function ensureAuthUser(
  admin: SupabaseClient,
  email: string
): Promise<{ userId: string; created: boolean }> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (!error && data.user) return { userId: data.user.id, created: true };

  // Already registered → attach the existing account instead.
  const existingId = await findUserIdByEmail(admin, email);
  if (existingId) return { userId: existingId, created: false };
  throw error ?? new Error('Konto konnte nicht angelegt werden.');
}

/** Password-setup link: recovery token redeemed by /invite/passwort. */
export async function buildPasswordSetupLink(
  admin: SupabaseClient,
  email: string
): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email });
  if (error || !data.properties?.hashed_token) {
    throw error ?? new Error('Einladungslink konnte nicht erzeugt werden.');
  }
  const appUrl = (process.env.APP_URL ?? '').replace(/\/+$/, '');
  if (!appUrl) throw new Error('APP_URL ist nicht gesetzt.');
  return `${appUrl}/invite/passwort?token_hash=${encodeURIComponent(data.properties.hashed_token)}`;
}

function systemFrom(): string {
  const from = process.env.RESEND_FROM;
  if (!from) throw new Error('RESEND_FROM ist nicht gesetzt.');
  return from;
}

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Invite mail for a NEW account: greeting + password-setup button. */
export async function sendInviteMail(params: {
  to: string;
  orgName: string;
  link: string;
}): Promise<void> {
  const subject = `Einladung: Ihr Zugang zu ${params.orgName} bei Zendori`;
  const text = [
    `Hallo,`,
    ``,
    `Sie wurden zum Team von ${params.orgName} bei Zendori eingeladen.`,
    `Legen Sie über diesen Link Ihr Passwort fest, um loszulegen:`,
    ``,
    params.link,
    ``,
    `Der Link ist zeitlich begrenzt gültig. Falls er abgelaufen ist, kann Ihr Team eine neue Einladung senden.`,
  ].join('\n');
  const html = `
<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
  <h2 style="margin:0 0 12px">Willkommen bei Zendori</h2>
  <p>Sie wurden zum Team von <strong>${esc(params.orgName)}</strong> eingeladen.</p>
  <p>Legen Sie Ihr Passwort fest, um loszulegen:</p>
  <p style="margin:24px 0">
    <a href="${esc(params.link)}"
       style="background:#0bb8ba;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:9999px;font-weight:600">
      Passwort festlegen
    </a>
  </p>
  <p style="color:#64748b;font-size:13px">Der Link ist zeitlich begrenzt gültig. Falls er abgelaufen ist, kann Ihr Team eine neue Einladung senden.</p>
</div>`;
  await sendEmail({ from: systemFrom(), to: params.to, subject, text, html });
}

/** Mail for an EXISTING account that was added to another org's team. */
export async function sendAddedToTeamMail(params: {
  to: string;
  orgName: string;
}): Promise<void> {
  const appUrl = (process.env.APP_URL ?? '').replace(/\/+$/, '');
  const loginUrl = appUrl ? `${appUrl}/login` : '';
  const subject = `Sie wurden zum Team von ${params.orgName} hinzugefügt`;
  const text = [
    `Hallo,`,
    ``,
    `Ihr bestehendes Zendori-Konto wurde zum Team von ${params.orgName} hinzugefügt.`,
    `Melden Sie sich wie gewohnt an — die Organisation erscheint in Ihrer Auswahl.`,
    loginUrl ? `` : '',
    loginUrl,
  ].join('\n');
  const html = `
<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
  <h2 style="margin:0 0 12px">Neues Team in Zendori</h2>
  <p>Ihr bestehendes Zendori-Konto wurde zum Team von <strong>${esc(params.orgName)}</strong> hinzugefügt.</p>
  <p>Melden Sie sich wie gewohnt an — die Organisation erscheint in Ihrer Auswahl.</p>
  ${loginUrl ? `<p style="margin:24px 0"><a href="${esc(loginUrl)}" style="background:#0bb8ba;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:9999px;font-weight:600">Zur Anmeldung</a></p>` : ''}
</div>`;
  await sendEmail({ from: systemFrom(), to: params.to, subject, text, html });
}
