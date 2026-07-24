import 'server-only';
import { sendEmail } from '@zendori/channels';
import type { SupabaseClient } from '@zendori/core';
import { escapeHtml, renderZendoriEmail } from './mail-templates';

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

function appUrl(): string {
  return (process.env.APP_URL ?? 'https://app.zendori.ai').replace(/\/+$/, '');
}

/** Invite mail for a NEW account: branded card + password-setup CTA. */
export async function sendInviteMail(params: {
  to: string;
  orgName: string;
  link: string;
}): Promise<void> {
  const orgName = escapeHtml(params.orgName);
  const { html, text } = renderZendoriEmail({
    preheader: `Ihr Zugang zum Team von ${params.orgName} — Passwort festlegen und loslegen.`,
    paragraphs: [
      `Sie wurden zum Team von <strong>${orgName}</strong> bei Zendori eingeladen — der Plattform für Kundenservice über alle Kanäle.`,
      `Legen Sie jetzt Ihr persönliches Passwort fest, um loszulegen:`,
    ],
    cta: { label: 'Passwort festlegen', url: params.link },
    finePrint:
      'Der Link ist zeitlich begrenzt gültig. Falls er abgelaufen ist, kann Ihr Team jederzeit eine neue Einladung senden.',
    appUrl: appUrl(),
  });
  await sendEmail({
    from: systemFrom(),
    to: params.to,
    subject: `Einladung: Ihr Zugang zu ${params.orgName} bei Zendori`,
    text,
    html,
  });
}

/** Mail for an EXISTING account that was added to another org's team. */
export async function sendAddedToTeamMail(params: {
  to: string;
  orgName: string;
}): Promise<void> {
  const orgName = escapeHtml(params.orgName);
  const { html, text } = renderZendoriEmail({
    preheader: `Ihr Zendori-Konto wurde zum Team von ${params.orgName} hinzugefügt.`,
    paragraphs: [
      `Ihr bestehendes Zendori-Konto wurde zum Team von <strong>${orgName}</strong> hinzugefügt.`,
      `Melden Sie sich wie gewohnt an — die Organisation erscheint anschließend in Ihrer Auswahl.`,
    ],
    cta: { label: 'Zur Anmeldung', url: `${appUrl()}/login` },
    appUrl: appUrl(),
  });
  await sendEmail({
    from: systemFrom(),
    to: params.to,
    subject: `Sie wurden zum Team von ${params.orgName} hinzugefügt`,
    text,
    html,
  });
}
