import { z } from 'zod';
import { isGermanMobile, maskDemoPhone, type DemoTranscriptTurn } from '@zendori/core';
import type { FunctionTool } from '../voice/xai-realtime.js';

// Demo-Anruf: what the demo assistant can DO during the call besides talking —
// take a (demo) ticket, send one SMS, send one summary e-mail. The limits are
// enforced HERE, not just promised in the prompt: the tools have no recipient
// parameter (SMS → the number being called, mail → the address from the lead
// form), each channel is capped per call, and model-written text is stripped
// of links/addresses and bounded before it leaves. Nothing touches a tenant
// org: the "ticket" lives only in the demo transcript (role 'action'), next to
// the SMS/mail markers, so the admin list and the sales mail show what
// happened. Never logs message content (§7).

export interface DemoToolLead {
  company: string;
  contactName: string;
  phoneE164: string;
  /** Address from the lead form (public: required but unverified; admin: optional). */
  email: string | null;
}

/** Which outbound tools this call may use (decided once at session start). */
export interface DemoCapabilities {
  sms: boolean;
  email: boolean;
}

export function demoCapabilities(
  lead: Pick<DemoToolLead, 'phoneE164' | 'email'>,
  configured: { sms: boolean; email: boolean }
): DemoCapabilities {
  return {
    // landlines cannot receive SMS
    sms: configured.sms && isGermanMobile(lead.phoneE164),
    email: configured.email && Boolean(lead.email),
  };
}

export interface DemoSummaryMail {
  subject: string;
  text: string;
  html: string;
}

/** Side effects, injected by the runner (and stubbed in tests). */
export interface DemoToolDeps {
  sendSms(to: string, body: string): Promise<void>;
  sendMail(to: string, mail: DemoSummaryMail): Promise<void>;
}

export interface DemoToolState {
  ticketId: string | null;
  smsSent: number;
  emailSent: number;
}

export function newDemoToolState(): DemoToolState {
  return { ticketId: null, smsSent: 0, emailSent: 0 };
}

export interface DemoToolContext {
  lead: DemoToolLead;
  capabilities: DemoCapabilities;
  deps: DemoToolDeps;
  state: DemoToolState;
  /** Test seam: deterministic ticket numbers. */
  nextTicketId?: () => string;
}

export interface DemoToolResult {
  /** function_call_output for the model (never spoken verbatim). */
  output: Record<string, unknown>;
  /** Marker for the transcript when something actually happened. */
  turn?: DemoTranscriptTurn;
}

export const DEMO_MAX_SMS_PER_CALL = 1;
export const DEMO_MAX_EMAILS_PER_CALL = 1;
const SMS_TEXT_MAX = 240;
const MAIL_SUMMARY_MAX = 900;
const MAIL_STEPS_MAX = 400;

// --- tool definitions ---------------------------------------------------------------

const CREATE_TICKET_TOOL: FunctionTool = {
  type: 'function',
  name: 'create_ticket',
  description:
    'Nimmt ein Anliegen als Demo-Ticket auf (Problem, Reklamation, Rückruf- oder Terminwunsch). Erst aufrufen, wenn das Anliegen zusammengefasst und vom Gesprächspartner bestätigt ist. Gibt die Ticketnummer zurück. Ein zweiter Aufruf im selben Anruf aktualisiert dasselbe Ticket.',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Kurzer Betreff des Anliegens (höchstens 120 Zeichen).' },
      description: {
        type: 'string',
        description: 'Das Anliegen in ein bis drei Sätzen: worum geht es, was soll passieren.',
      },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high', 'urgent'],
        description: 'Dringlichkeit; ohne klare Angabe normal.',
      },
    },
    required: ['subject', 'description'],
  },
};

const SEND_SMS_TOOL: FunctionTool = {
  type: 'function',
  name: 'send_sms',
  description:
    'Sendet EINE kurze SMS an die Nummer, die du gerade anrufst (kein anderer Empfänger möglich). Nur aufrufen, wenn der Gesprächspartner im Anruf ausdrücklich zugestimmt hat. Inhalt: die wichtigsten Infos aus dem Gespräch, z. B. Ticketnummer, vereinbarter Rückruf, nächste Schritte. Keine Links, keine Werbung.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: `Der SMS-Text, sachlich, höchstens ${SMS_TEXT_MAX} Zeichen. Absender und Demo-Hinweis ergänzt das System.`,
      },
    },
    required: ['text'],
  },
};

const SEND_EMAIL_TOOL: FunctionTool = {
  type: 'function',
  name: 'send_email',
  description:
    'Sendet EINE Zusammenfassung des Gesprächs an die E-Mail-Adresse aus dem Demo-Formular (kein anderer Empfänger möglich). Nur aufrufen, wenn der Gesprächspartner im Anruf ausdrücklich zugestimmt hat. Keine Links, keine Werbung.',
  parameters: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Was besprochen wurde, in zwei bis fünf Sätzen.',
      },
      next_steps: {
        type: 'string',
        description: 'Optional: was als Nächstes passiert (z. B. Rückruf, Termin), ein bis zwei Sätze.',
      },
    },
    required: ['summary'],
  },
};

/** Tools offered to the model besides end_call — only what this call can really do. */
export function buildDemoActionTools(capabilities: DemoCapabilities): FunctionTool[] {
  return [
    CREATE_TICKET_TOOL,
    ...(capabilities.sms ? [SEND_SMS_TOOL] : []),
    ...(capabilities.email ? [SEND_EMAIL_TOOL] : []),
  ];
}

// --- text hygiene -------------------------------------------------------------------

const LINK_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_PATTERN = /\S+@\S+\.\S+/g;
/** Bare domains ("beispiel.de/abc") — a clickable link in every SMS app and mail client. */
const DOMAIN_PATTERN =
  /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:de|com|net|org|io|ai|eu|at|ch|info|biz|app|co|me|ly|shop|online|site|xyz|top|link|click|ru|cn|tk)\b(?:\/\S*)?/gi;

/**
 * Model-written text that leaves the call (SMS, mail): no links, no e-mail
 * addresses, no control characters, single spaces, bounded. The only link a
 * demo message carries is the fixed zendori.ai footer added by the templates.
 */
export function sanitizeOutbound(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(LINK_PATTERN, '')
    .replace(EMAIL_PATTERN, '')
    .replace(DOMAIN_PATTERN, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength)
    .trim();
}

const GSM7 = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€'
);
const GSM7_REPLACEMENTS: [RegExp, string][] = [
  [/[„“”«»]/g, '"'],
  [/[‚‘’`´]/g, "'"],
  [/[–—−]/g, '-'],
  [/…/g, '...'],
  [/ /g, ' '],
];

/**
 * Keeps an SMS in the GSM-7 alphabet (160 chars per segment instead of 70):
 * typographic characters are mapped, everything else outside the alphabet
 * (emoji, exotic symbols) is dropped. German umlauts and ß are part of GSM-7.
 */
export function toGsm7(value: string): string {
  let text = value;
  for (const [pattern, replacement] of GSM7_REPLACEMENTS) text = text.replace(pattern, replacement);
  return [...text].filter((char) => GSM7.has(char)).join('');
}

function inline(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/** The complete SMS body: who it is from, the model's text, the fixed demo footer. */
export function buildDemoSmsBody(company: string, text: string): string {
  const sender = toGsm7(inline(company, 40));
  return `${sender}: ${toGsm7(text)}\n\nBeispiel-SMS aus dem Demo-Anruf mit Zendori. Mehr auf zendori.ai`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Summary mail to the lead: fixed frame, the model only fills two text blocks. */
export function renderDemoSummaryEmail(input: {
  company: string;
  contactName: string;
  phoneE164: string;
  summary: string;
  nextSteps: string | null;
  ticketId: string | null;
}): DemoSummaryMail {
  const company = inline(input.company, 120);
  const subject = `Zusammenfassung des Demo-Anrufs: ${company}`;
  const intro = `der KI-Telefonassistent von ${company} hat diese Zusammenfassung im Demo-Anruf auf Wunsch verschickt.`;
  const everyday =
    'So läuft es im Alltag: Der Agent beantwortet Fragen aus dem Firmenwissen, nimmt Anliegen als Ticket auf und übergibt an das Team, wenn er nicht weiterkommt. Am Telefon, per WhatsApp, im Website-Chat und per E-Mail.';
  const origin = `Diese E-Mail wurde aus einem Demo-Anruf heraus ausgelöst, der über zendori.ai für die Nummer ${maskDemoPhone(input.phoneE164)} angefordert wurde. Nicht angefordert? Dann ist nichts weiter zu tun.`;

  const text = [
    `Hallo ${inline(input.contactName, 120)},`,
    '',
    intro,
    '',
    'Besprochen:',
    input.summary,
    ...(input.nextSteps ? ['', 'Nächste Schritte:', input.nextSteps] : []),
    ...(input.ticketId ? ['', `Demo-Ticket: ${input.ticketId}`] : []),
    '',
    everyday,
    '',
    'Mehr über Zendori: https://zendori.ai',
    '',
    origin,
  ].join('\n');

  const block = (title: string, body: string): string =>
    `<h2 style="font-size:14px;margin:20px 0 6px;color:#0b1220;">${escapeHtml(title)}</h2><p style="margin:0;white-space:pre-wrap;line-height:1.6;">${escapeHtml(body)}</p>`;
  const html = `<!doctype html><html lang="de"><body style="margin:0;padding:24px;background:#f4f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#334155;font-size:15px;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;">
<p style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#0b7480;">Demo-Anruf mit Zendori</p>
<h1 style="font-size:20px;margin:0 0 16px;color:#0b1220;">Zusammenfassung für ${escapeHtml(company)}</h1>
<p style="margin:0 0 4px;line-height:1.6;">Hallo ${escapeHtml(inline(input.contactName, 120))},</p>
<p style="margin:0;line-height:1.6;">${escapeHtml(intro)}</p>
${block('Besprochen', input.summary)}
${input.nextSteps ? block('Nächste Schritte', input.nextSteps) : ''}
${input.ticketId ? `<p style="margin:16px 0 0;"><span style="display:inline-block;padding:4px 10px;border-radius:999px;background:#e6f6f5;color:#0b7480;font-size:13px;font-weight:600;">Demo-Ticket ${escapeHtml(input.ticketId)}</span></p>` : ''}
<p style="margin:22px 0 0;padding:14px 16px;border-radius:12px;background:#f4f7fa;font-size:14px;line-height:1.6;">${escapeHtml(everyday)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 0;"><tr><td style="border-radius:9999px;background:#0b7480;">
<a href="https://zendori.ai" style="display:inline-block;padding:12px 26px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">Mehr über Zendori</a>
</td></tr></table>
<p style="margin:22px 0 0;font-size:12px;line-height:1.5;color:#64748b;">${escapeHtml(origin)}</p>
</div></body></html>`;
  return { subject, text, html };
}

// --- handlers -----------------------------------------------------------------------

const ticketArgsSchema = z.object({
  subject: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
});
const smsArgsSchema = z.object({ text: z.string().min(1) });
const emailArgsSchema = z.object({
  summary: z.string().min(1),
  next_steps: z.string().optional(),
});

const PRIORITY_LABEL = { low: 'niedrig', normal: 'normal', high: 'hoch', urgent: 'dringend' } as const;

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
}

function refused(error: string, instruction: string): DemoToolResult {
  return { output: { ok: false, error, instruction } };
}

function actionTurn(kind: NonNullable<DemoTranscriptTurn['kind']>, text: string): DemoTranscriptTurn {
  return { role: 'action', kind, text, at: new Date().toISOString() };
}

function randomTicketId(): string {
  return `DEMO-${1000 + Math.floor(Math.random() * 9000)}`;
}

function createTicket(ctx: DemoToolContext, raw: string): DemoToolResult {
  const parsed = ticketArgsSchema.safeParse(parseArgs(raw));
  if (!parsed.success) {
    return refused(
      'invalid_arguments',
      'Dir fehlen Betreff oder Beschreibung. Frage kurz nach, worum es geht, und versuche es erneut.'
    );
  }
  const subject = sanitizeOutbound(parsed.data.subject, 120);
  const description = sanitizeOutbound(parsed.data.description, 600);
  if (!subject || !description) {
    return refused('invalid_arguments', 'Frage kurz nach, worum es geht, und versuche es erneut.');
  }
  const updated = ctx.state.ticketId !== null;
  const ticketId = ctx.state.ticketId ?? (ctx.nextTicketId ?? randomTicketId)();
  ctx.state.ticketId = ticketId;
  const priority = PRIORITY_LABEL[parsed.data.priority ?? 'normal'];
  const followUps = [
    ...(ctx.capabilities.sms && ctx.state.smsSent < DEMO_MAX_SMS_PER_CALL ? ['per SMS'] : []),
    ...(ctx.capabilities.email && ctx.state.emailSent < DEMO_MAX_EMAILS_PER_CALL ? ['per E-Mail'] : []),
  ];
  return {
    output: {
      ok: true,
      ticket_id: ticketId,
      instruction:
        `Sage, dass das Anliegen ${updated ? 'aktualisiert' : 'aufgenommen'} ist, und nenne die Ticketnummer ${ticketId} einmal deutlich (die Ziffern einzeln). ` +
        `Erkläre in einem Satz, dass das Team von ${inline(ctx.lead.company, 120)} das Anliegen im echten Einsatz so in seinem Posteingang sieht — hier ist es ein Demo-Ticket.` +
        (followUps.length > 0
          ? ` Biete danach einmal an, die Zusammenfassung ${followUps.join(' oder ')} zu schicken.`
          : ''),
    },
    turn: actionTurn(
      'ticket',
      `Ticket ${ticketId} ${updated ? 'aktualisiert' : 'aufgenommen'} (Priorität ${priority}): ${subject} — ${description}`
    ),
  };
}

async function sendSms(ctx: DemoToolContext, raw: string): Promise<DemoToolResult> {
  if (!ctx.capabilities.sms) {
    return refused(
      'not_available',
      'In diesem Anruf ist keine SMS möglich. Sage das ehrlich in einem Satz und mach normal weiter.'
    );
  }
  if (ctx.state.smsSent >= DEMO_MAX_SMS_PER_CALL) {
    return refused(
      'limit_reached',
      'In dieser Demo geht nur eine SMS, und die ist schon verschickt. Sage das kurz und mach normal weiter.'
    );
  }
  const parsed = smsArgsSchema.safeParse(parseArgs(raw));
  const text = parsed.success ? sanitizeOutbound(parsed.data.text, SMS_TEXT_MAX) : '';
  if (text.length < 5) {
    return refused('invalid_arguments', 'Der SMS-Text fehlt. Formuliere ihn kurz und versuche es erneut.');
  }
  const body = buildDemoSmsBody(ctx.lead.company, text);
  // count BEFORE sending: a hanging provider must not allow a second attempt
  ctx.state.smsSent += 1;
  try {
    await ctx.deps.sendSms(ctx.lead.phoneE164, body);
  } catch {
    return refused(
      'send_failed',
      'Die SMS konnte gerade nicht verschickt werden. Sage das ehrlich in einem Satz und mach normal weiter.'
    );
  }
  return {
    output: {
      ok: true,
      instruction: 'Sage in einem Satz, dass die SMS unterwegs ist und gleich ankommt.',
    },
    turn: actionTurn('sms', `SMS gesendet: ${body.split('\n')[0] ?? ''}`),
  };
}

async function sendEmailSummary(ctx: DemoToolContext, raw: string): Promise<DemoToolResult> {
  const to = ctx.lead.email;
  if (!ctx.capabilities.email || !to) {
    return refused(
      'not_available',
      'In diesem Anruf ist keine E-Mail möglich. Sage das ehrlich in einem Satz und mach normal weiter.'
    );
  }
  if (ctx.state.emailSent >= DEMO_MAX_EMAILS_PER_CALL) {
    return refused(
      'limit_reached',
      'In dieser Demo geht nur eine E-Mail, und die ist schon verschickt. Sage das kurz und mach normal weiter.'
    );
  }
  const parsed = emailArgsSchema.safeParse(parseArgs(raw));
  const summary = parsed.success ? sanitizeOutbound(parsed.data.summary, MAIL_SUMMARY_MAX) : '';
  if (summary.length < 10) {
    return refused(
      'invalid_arguments',
      'Die Zusammenfassung fehlt. Fasse das Gespräch in zwei bis fünf Sätzen zusammen und versuche es erneut.'
    );
  }
  const nextSteps =
    parsed.success && parsed.data.next_steps
      ? sanitizeOutbound(parsed.data.next_steps, MAIL_STEPS_MAX) || null
      : null;
  ctx.state.emailSent += 1;
  try {
    await ctx.deps.sendMail(
      to,
      renderDemoSummaryEmail({
        company: ctx.lead.company,
        contactName: ctx.lead.contactName,
        phoneE164: ctx.lead.phoneE164,
        summary,
        nextSteps,
        ticketId: ctx.state.ticketId,
      })
    );
  } catch {
    return refused(
      'send_failed',
      'Die E-Mail konnte gerade nicht verschickt werden. Sage das ehrlich in einem Satz und mach normal weiter.'
    );
  }
  return {
    output: {
      ok: true,
      instruction:
        'Sage in einem Satz, dass die Zusammenfassung an die E-Mail-Adresse aus dem Formular unterwegs ist. Nenne die Adresse nicht.',
    },
    turn: actionTurn('email', `E-Mail mit Zusammenfassung gesendet: ${summary}`),
  };
}

/** Runs one action tool. Unknown names are refused (end_call is the session's own business). */
export async function runDemoTool(
  ctx: DemoToolContext,
  name: string,
  rawArgs: string
): Promise<DemoToolResult> {
  switch (name) {
    case 'create_ticket':
      return createTicket(ctx, rawArgs);
    case 'send_sms':
      return sendSms(ctx, rawArgs);
    case 'send_email':
      return sendEmailSummary(ctx, rawArgs);
    default:
      return { output: { ok: false, error: 'unknown tool' } };
  }
}
