import type { DemoStatus, DemoTranscriptTurn } from '@zendori/core';
import { sendEmail } from '@zendori/channels';

// Demo-Anruf (0032): sales notification for a PUBLIC demo lead once its call
// reached a terminal outcome — lead data, outcome and transcript in one mail,
// Reply-To = the lead so sales can answer directly. Admin demos never mail.

export interface DemoLeadMailInput {
  company: string;
  contactName: string;
  email: string | null;
  phoneE164: string;
  websiteUrl: string | null;
  prompt: string;
  status: DemoStatus;
  durationSeconds: number | null;
  createdAt: string;
  transcript: DemoTranscriptTurn[];
  adminUrl: string;
}

const OUTCOME: Partial<Record<DemoStatus, string>> = {
  completed: 'Gespräch geführt',
  no_answer: 'Nicht abgenommen',
  busy: 'Besetzt',
  failed: 'Fehlgeschlagen',
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} min`;
}

const dateFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Berlin',
});

export function renderDemoLeadEmail(input: DemoLeadMailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const outcome = OUTCOME[input.status] ?? input.status;
  const subject = `Neuer Demo-Lead: ${input.company} (${outcome})`;
  const facts: [string, string][] = [
    ['Unternehmen', input.company],
    ['Ansprechpartner', input.contactName],
    ['E-Mail', input.email ?? '—'],
    ['Telefon', input.phoneE164],
    ['Website', input.websiteUrl ?? '—'],
    ['Angefragt', dateFormat.format(new Date(input.createdAt))],
    ['Ergebnis', outcome],
    ['Dauer', formatDuration(input.durationSeconds)],
  ];
  const speaker = (turn: DemoTranscriptTurn): string =>
    turn.role === 'assistant' ? 'Assistent' : 'Lead';

  const text = [
    ...facts.map(([k, v]) => `${k}: ${v}`),
    '',
    'Anweisung für den Anruf:',
    input.prompt || '— (Standard-Demo)',
    '',
    'Transkript:',
    ...(input.transcript.length > 0
      ? input.transcript.map((t) => `${speaker(t)}: ${t.text}`)
      : ['— (kein Gespräch)']),
    '',
    `Alle Demo-Anrufe: ${input.adminUrl}`,
  ].join('\n');

  const rows = facts
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#64748b;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:4px 0;">${escapeHtml(v)}</td></tr>`
    )
    .join('');
  const transcriptHtml =
    input.transcript.length > 0
      ? input.transcript
          .map(
            (t) =>
              `<p style="margin:0 0 6px;"><strong>${escapeHtml(speaker(t))}:</strong> ${escapeHtml(t.text)}</p>`
          )
          .join('')
      : '<p style="margin:0;color:#64748b;">— (kein Gespräch)</p>';
  const html = `<!doctype html><html lang="de"><body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;font-size:14px;">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;padding:24px;">
<h1 style="font-size:18px;margin:0 0 14px;">Neuer Demo-Lead: ${escapeHtml(input.company)}</h1>
<table role="presentation" cellpadding="0" cellspacing="0">${rows}</table>
<h2 style="font-size:15px;margin:20px 0 6px;">Anweisung für den Anruf</h2>
<p style="margin:0;white-space:pre-wrap;">${escapeHtml(input.prompt || '— (Standard-Demo)')}</p>
<h2 style="font-size:15px;margin:20px 0 6px;">Transkript</h2>
${transcriptHtml}
<p style="margin:20px 0 0;"><a href="${escapeHtml(input.adminUrl)}" style="color:#0e9f9c;">Alle Demo-Anrufe im Admin-Bereich</a></p>
</div></body></html>`;
  return { subject, text, html };
}

export async function sendDemoLeadEmail(to: string, input: DemoLeadMailInput): Promise<void> {
  const from = process.env.RESEND_FROM;
  if (!from) throw new Error('RESEND_FROM is not set');
  const mail = renderDemoLeadEmail(input);
  await sendEmail({
    from,
    to,
    ...(input.email ? { replyTo: input.email } : {}),
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}
