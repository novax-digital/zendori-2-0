import 'server-only';
import { createHmac } from 'node:crypto';
import { sendEmail } from '@zendori/channels';
import { CONTACT_TOPIC_LABELS, type ContactRequestData } from '@zendori/core';

// Server-side helpers of the contact form (0034): IP pseudonymization and the
// notification mail to the operator inbox. See docs/contact-requests.md.

/** Where new contact requests are announced; CONTACT_NOTIFY_EMAIL overrides. */
export const DEFAULT_CONTACT_NOTIFY_EMAIL = 'info@zendori.ai';

export function contactNotifyEmail(): string {
  return process.env.CONTACT_NOTIFY_EMAIL?.trim() || DEFAULT_CONTACT_NOTIFY_EMAIL;
}

/**
 * Pseudonymized client IP for abuse forensics: HMAC keyed with the master key,
 * so the column never holds a raw IP (DSGVO data minimization).
 */
export function hashContactIp(ip: string): string | null {
  const key = process.env.MASTER_ENCRYPTION_KEY;
  if (!key) return null;
  return createHmac('sha256', Buffer.from(key, 'base64'))
    .update(`contact-ip:${ip}`)
    .digest('hex')
    .slice(0, 32);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const dateFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Berlin',
});

export function renderContactNotification(input: {
  request: ContactRequestData;
  createdAt: string;
  adminUrl: string;
}): { subject: string; text: string; html: string } {
  const { request } = input;
  const topic = CONTACT_TOPIC_LABELS[request.topic];
  const who = request.company ? `${request.name} (${request.company})` : request.name;
  const subject = `Neue Kontaktanfrage: ${who} — ${topic}`;
  const facts: [string, string][] = [
    ['Name', request.name],
    ['E-Mail', request.email],
    ['Unternehmen', request.company ?? '—'],
    ['Telefon', request.phone ?? '—'],
    ['Thema', topic],
    ['Eingegangen', dateFormat.format(new Date(input.createdAt))],
  ];

  const text = [
    ...facts.map(([k, v]) => `${k}: ${v}`),
    '',
    'Nachricht:',
    request.message,
    '',
    `Im Admin-Bereich öffnen: ${input.adminUrl}`,
    'Antworten auf diese E-Mail gehen direkt an den Absender der Anfrage.',
  ].join('\n');

  const rows = facts
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#64748b;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:4px 0;">${escapeHtml(v)}</td></tr>`
    )
    .join('');
  const html = `<!doctype html><html lang="de"><body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;font-size:14px;">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;padding:24px;">
<h1 style="font-size:18px;margin:0 0 14px;">Neue Kontaktanfrage: ${escapeHtml(who)}</h1>
<table role="presentation" cellpadding="0" cellspacing="0">${rows}</table>
<h2 style="font-size:15px;margin:20px 0 6px;">Nachricht</h2>
<p style="margin:0;white-space:pre-wrap;line-height:1.6;">${escapeHtml(request.message)}</p>
<p style="margin:20px 0 0;"><a href="${escapeHtml(input.adminUrl)}" style="color:#0b7480;">Im Admin-Bereich öffnen</a></p>
<p style="margin:8px 0 0;font-size:12px;color:#64748b;">Antworten auf diese E-Mail gehen direkt an den Absender der Anfrage.</p>
</div></body></html>`;
  return { subject, text, html };
}

/** Announces a request in the operator inbox; Reply-To = the requester. Throws on failure. */
export async function sendContactNotification(input: {
  request: ContactRequestData;
  createdAt: string;
  requestId: string;
}): Promise<void> {
  const from = process.env.RESEND_FROM;
  if (!from) throw new Error('RESEND_FROM is not set');
  const appUrl = (process.env.APP_URL ?? 'https://app.zendori.ai').replace(/\/+$/, '');
  const mail = renderContactNotification({
    request: input.request,
    createdAt: input.createdAt,
    adminUrl: `${appUrl}/admin/contact?panel=request&id=${input.requestId}`,
  });
  await sendEmail({
    from,
    to: contactNotifyEmail(),
    replyTo: input.request.email,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}
