import { z } from 'zod';

// Demo-Anruf (operator lead capture + outbound voice demo, migration 0032).
// Shared, side-effect-free helpers for the public demo embed routes, the
// admin demo and the worker: lead validation, phone allowlist, status model.
// See docs/demo-call.md.

export const DEMO_STATUSES = [
  'awaiting_confirmation',
  'queued',
  'preparing',
  'dialing',
  'connecting',
  'in_call',
  'completed',
  'no_answer',
  'busy',
  'failed',
  'expired',
] as const;
export type DemoStatus = (typeof DEMO_STATUSES)[number];

/** Rows the worker still has to drive (also the concurrency-cap set minus awaiting/queued). */
export const DEMO_RUNNING_STATUSES: readonly DemoStatus[] = [
  'preparing',
  'dialing',
  'connecting',
  'in_call',
];
export const DEMO_TERMINAL_STATUSES: readonly DemoStatus[] = [
  'completed',
  'no_answer',
  'busy',
  'failed',
  'expired',
];

export function isTerminalDemoStatus(status: DemoStatus): boolean {
  return DEMO_TERMINAL_STATUSES.includes(status);
}

/**
 * What the public embed / confirm page may see: a coarse status, never lead
 * data or internal details (preparing/dialing/connecting collapse).
 */
export type DemoPublicStatus =
  | 'awaiting_confirmation'
  | 'queued'
  | 'calling'
  | 'in_call'
  | 'completed'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'expired';

export function toPublicDemoStatus(status: DemoStatus): DemoPublicStatus {
  switch (status) {
    case 'preparing':
      return 'queued';
    case 'dialing':
    case 'connecting':
      return 'calling';
    default:
      return status;
  }
}

/** Bumped whenever the consent wording in the embed changes (stored per lead). */
export const DEMO_CONSENT_VERSION = '2026-11-13';

/** Render-token scope for the demo embed (HMAC input; never collides with 32-hex form tokens). */
export const DEMO_RENDER_SCOPE = 'demo-call';

/**
 * A public request must be verified (SMS/voice code) within this window,
 * resends included — a demo is wanted now, not tomorrow. Twilio Verify codes
 * themselves live 10 min; a resend issues a fresh one.
 */
export const DEMO_VERIFY_TTL_MS = 20 * 60 * 1000;

/** Code deliveries per request (initial + resends) — SMS-bombing guard. */
export const DEMO_CODE_MAX_SENDS = 3;

/** Minimum gap between two code deliveries of one request. */
export const DEMO_CODE_RESEND_COOLDOWN_SECONDS = 30;

/** Wrong-code attempts per request before it is closed (Twilio allows 5 per code). */
export const DEMO_CODE_MAX_ATTEMPTS = 5;

/** Max successful demo calls per phone number within 24 h (web cap, fail-closed). */
export const DEMO_MAX_CALLS_PER_PHONE_PER_DAY = 2;

/**
 * Max public REQUESTS (each one sends codes) per phone number within 24 h,
 * verified or not — together with DEMO_CODE_MAX_SENDS this bounds the codes a
 * stranger can trigger to one number per day.
 */
export const DEMO_MAX_REQUESTS_PER_PHONE_PER_DAY = 3;

/** Default global cap of confirmed public demos per day (env DEMO_DAILY_LIMIT overrides). */
export const DEMO_DEFAULT_DAILY_LIMIT = 50;

// --- phone ---------------------------------------------------------------------

export type DemoPhoneResult =
  | { ok: true; e164: string }
  | { ok: false; reason: 'invalid' | 'not_allowed' };

/**
 * Normalizes a German phone number to E.164 and enforces the demo allowlist:
 * German mobile (015x/016x/017x) and geographic/national numbers only. Blocks
 * every special-rate or service range a public form could be abused to dial
 * (010 call-by-call, 0118 directory, 0137 mass calling, 018x/019x services,
 * 0700 personal, 0800 free-phone, 0900 premium) and all foreign numbers.
 */
export function normalizeDemoPhone(raw: string): DemoPhoneResult {
  let digits = raw.trim().replace(/[\s\-/().]/g, '');
  if (digits.length === 0) return { ok: false, reason: 'invalid' };

  if (digits.startsWith('+')) {
    if (!digits.startsWith('+49')) {
      return /^\+[1-9]\d{6,14}$/.test(digits)
        ? { ok: false, reason: 'not_allowed' }
        : { ok: false, reason: 'invalid' };
    }
    digits = digits.slice(3);
  } else if (digits.startsWith('00')) {
    if (!digits.startsWith('0049')) {
      return /^00[1-9]\d{6,14}$/.test(digits)
        ? { ok: false, reason: 'not_allowed' }
        : { ok: false, reason: 'invalid' };
    }
    digits = digits.slice(4);
  } else if (digits.startsWith('0')) {
    digits = digits.slice(1);
  } else {
    return { ok: false, reason: 'invalid' };
  }
  // "+49 (0) 170 …" → the trunk zero survives the international prefix once.
  if (digits.startsWith('0')) digits = digits.slice(1);

  // National significant number: no leading zero, 6–12 digits.
  if (!/^[1-9]\d{5,11}$/.test(digits)) return { ok: false, reason: 'invalid' };

  const mobile = /^1[567]/.test(digits);
  if (digits.startsWith('1') && !mobile) return { ok: false, reason: 'not_allowed' };
  if (/^(700|800|900)/.test(digits)) return { ok: false, reason: 'not_allowed' };
  if (mobile && digits.length < 10) return { ok: false, reason: 'invalid' };

  return { ok: true, e164: `+49${digits}` };
}

// --- website URL -----------------------------------------------------------------

/** Normalizes an optional website field: adds https://, http(s) only, no credentials. */
export function normalizeDemoWebsite(raw: string | null | undefined): string | null | 'invalid' {
  const value = (raw ?? '').trim();
  if (value.length === 0) return null;
  if (value.length > 300) return 'invalid';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return 'invalid';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'invalid';
  if (url.username || url.password) return 'invalid';
  if (!url.hostname.includes('.')) return 'invalid';
  const href = url.toString();
  return href.length <= 300 ? href : 'invalid';
}

// --- lead input --------------------------------------------------------------------

/** Single-line text: trimmed, whitespace collapsed, control characters removed. */
function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Free text: keeps line breaks, drops other control characters. */
function multiLine(value: string): string {
  return (
    value
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export const DEMO_PROMPT_MAX_CHARS = 1000;

/** Raw lead fields as both entry points (embed, admin form) submit them. */
export const demoLeadInputSchema = z.object({
  company: z.string().max(200),
  contactName: z.string().max(200),
  email: z.string().max(200).optional(),
  phone: z.string().max(40),
  websiteUrl: z.string().max(400).optional(),
  prompt: z.string().max(2000).optional(),
});
export type DemoLeadInput = z.infer<typeof demoLeadInputSchema>;

export interface DemoLead {
  company: string;
  contactName: string;
  email: string | null;
  phoneE164: string;
  websiteUrl: string | null;
  prompt: string;
}

export type DemoLeadField = 'company' | 'contactName' | 'email' | 'phone' | 'websiteUrl' | 'prompt';

export type DemoLeadResult =
  | { ok: true; lead: DemoLead }
  | { ok: false; errors: Partial<Record<DemoLeadField, string>> };

const emailSchema = z.email();

/**
 * Validates + normalizes a lead. Error texts are German UI copy (§8.7) and are
 * shown inline next to the field by the embed and the admin form.
 */
export function validateDemoLead(
  input: DemoLeadInput,
  options: { requireEmail: boolean }
): DemoLeadResult {
  const errors: Partial<Record<DemoLeadField, string>> = {};

  const company = singleLine(input.company);
  if (company.length < 2 || company.length > 120) {
    errors.company = 'Bitte gib den Namen deiner Firma an (2–120 Zeichen).';
  }

  const contactName = singleLine(input.contactName);
  if (contactName.length < 2 || contactName.length > 120) {
    errors.contactName = 'Bitte gib deinen Namen an (2–120 Zeichen).';
  }

  const rawEmail = singleLine(input.email ?? '').toLowerCase();
  let email: string | null = null;
  if (rawEmail.length === 0) {
    if (options.requireEmail) errors.email = 'Bitte gib deine E-Mail-Adresse an.';
  } else if (rawEmail.length > 200 || !emailSchema.safeParse(rawEmail).success) {
    errors.email = 'Bitte gib eine gültige E-Mail-Adresse an.';
  } else {
    email = rawEmail;
  }

  const phone = normalizeDemoPhone(input.phone);
  if (!phone.ok) {
    errors.phone =
      phone.reason === 'not_allowed'
        ? 'Demo-Anrufe sind nur an deutsche Mobil- oder Festnetznummern möglich (keine Sonder- oder Servicenummern).'
        : 'Bitte gib eine gültige deutsche Telefonnummer an, z. B. 0170 1234567.';
  }

  const website = normalizeDemoWebsite(input.websiteUrl);
  if (website === 'invalid') {
    errors.websiteUrl = 'Bitte gib eine gültige Website-Adresse an, z. B. www.beispiel.de.';
  }

  const prompt = multiLine(input.prompt ?? '');
  if (prompt.length > DEMO_PROMPT_MAX_CHARS) {
    errors.prompt = `Bitte fass dich kürzer (maximal ${DEMO_PROMPT_MAX_CHARS} Zeichen).`;
  }

  if (Object.keys(errors).length > 0 || !phone.ok || website === 'invalid') {
    return { ok: false, errors };
  }
  return {
    ok: true,
    lead: { company, contactName, email, phoneE164: phone.e164, websiteUrl: website, prompt },
  };
}

// --- phone verification (Twilio Verify) -----------------------------------------

export type DemoVerifyChannel = 'sms' | 'call';

/** German mobile numbers (015x/016x/017x) get an SMS; landlines a voice call reading the code. */
export function isGermanMobile(e164: string): boolean {
  return /^\+491[567]/.test(e164);
}

export function demoVerifyChannelFor(e164: string): DemoVerifyChannel {
  return isGermanMobile(e164) ? 'sms' : 'call';
}

export type DemoVerifySendFailure =
  | 'landline'
  | 'invalid_number'
  | 'rate_limited'
  | 'blocked'
  | 'unavailable';

/**
 * Maps a failed Twilio Verify "start verification" call to a demo outcome.
 * Codes: https://www.twilio.com/docs/api/errors (60200 invalid parameter,
 * 60203 max send attempts, 60205 SMS to landline, 60410 Fraud Guard block,
 * 60605 geo permission, 60212/20429 concurrency/rate).
 */
export function classifyVerifySendError(
  httpStatus: number,
  code: number | null
): DemoVerifySendFailure {
  switch (code) {
    case 60205:
      return 'landline';
    case 60200:
    case 21211:
    case 21614:
      return 'invalid_number';
    case 60203:
    case 60212:
    case 20429:
      return 'rate_limited';
    case 60410:
    case 60605:
    case 60220:
      return 'blocked';
    default:
      return httpStatus === 429 ? 'rate_limited' : 'unavailable';
  }
}

export type DemoVerifyCheckResult =
  | 'approved'
  | 'wrong_code'
  | 'code_expired'
  | 'max_attempts'
  | 'unavailable';

/**
 * Maps a Twilio Verify "verification check" response. A 404 (20404) means
 * there is no pending verification for the number any more: the code expired
 * (10 min), was already used, or the attempts are exhausted.
 */
export function classifyVerifyCheck(
  httpStatus: number,
  body: { status?: string | null; code?: number | null } | null
): DemoVerifyCheckResult {
  if (httpStatus >= 200 && httpStatus < 300) {
    return body?.status === 'approved' ? 'approved' : 'wrong_code';
  }
  if (body?.code === 60202) return 'max_attempts';
  if (httpStatus === 404 || body?.code === 20404) return 'code_expired';
  return 'unavailable';
}

// --- transcript --------------------------------------------------------------------

export const demoTranscriptTurnSchema = z.object({
  role: z.enum(['assistant', 'caller']),
  text: z.string(),
  at: z.string(),
});
export type DemoTranscriptTurn = z.infer<typeof demoTranscriptTurnSchema>;
export const demoTranscriptSchema = z.array(demoTranscriptTurnSchema);

/** Masks a phone number for public pages: +4917012345678 → +49 170 ••••• 78. */
export function maskDemoPhone(e164: string): string {
  if (!e164.startsWith('+49') || e164.length < 8) return '••••';
  const nsn = e164.slice(3);
  return `+49 ${nsn.slice(0, 3)} ${'•'.repeat(Math.max(3, nsn.length - 5))} ${nsn.slice(-2)}`;
}
