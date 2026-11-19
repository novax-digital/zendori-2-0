import 'server-only';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@zendori/core';
import {
  DEMO_DEFAULT_DAILY_LIMIT,
  DEMO_MAX_CALLS_PER_PHONE_PER_DAY,
  DEMO_MAX_REQUESTS_PER_PHONE_PER_DAY,
  DEMO_STATUSES,
  type DemoStatus,
  type DemoVerifySendFailure,
} from '@zendori/core';

// Server-side helpers for the public Demo-Anruf routes (request, verify,
// resend, status): opaque tokens (stored hashed), IP pseudonymization and the
// fail-closed DB caps. See docs/demo-call.md.

/** 32 random bytes as hex — status token (plain value never stored). */
export function newDemoToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashDemoToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export const DEMO_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Pseudonymized client IP for abuse forensics: HMAC keyed with the master key,
 * so the column never holds a raw IP (DSGVO data minimization).
 */
export function hashDemoIp(ip: string): string | null {
  const key = process.env.MASTER_ENCRYPTION_KEY;
  if (!key) return null;
  return createHmac('sha256', Buffer.from(key, 'base64'))
    .update(`demo-ip:${ip}`)
    .digest('hex')
    .slice(0, 32);
}

export function demoDailyLimit(): number {
  const raw = Number(process.env.DEMO_DAILY_LIMIT);
  return Number.isInteger(raw) && raw > 0 ? raw : DEMO_DEFAULT_DAILY_LIMIT;
}

export type DemoCapVerdict =
  | 'ok'
  | 'request_limit'
  | 'phone_limit'
  | 'daily_limit'
  | 'db_error';

export const DEMO_CAP_MESSAGES: Record<Exclude<DemoCapVerdict, 'ok'>, string> = {
  request_limit:
    'Für diese Telefonnummer wurden heute bereits mehrere Demos angefordert. Bitte versuch es morgen erneut.',
  phone_limit:
    'Für diese Telefonnummer wurden heute bereits Demo-Anrufe durchgeführt. Bitte versuch es morgen erneut.',
  daily_limit:
    'Heute sind leider keine Demo-Anrufe mehr verfügbar. Bitte versuch es morgen erneut.',
  db_error: 'Der Dienst ist vorübergehend nicht verfügbar. Bitte versuch es gleich erneut.',
};

/**
 * Hard caps (fail-closed — unlike the Upstash limits a DB error blocks the
 * demo). Checked on request (all three) and again after the code was verified
 * (calls + global only):
 * - requests: DEMO_MAX_REQUESTS_PER_PHONE_PER_DAY public requests per number
 *   within 24 h, verified or not — each one sends codes (SMS-bombing guard)
 * - calls: DEMO_MAX_CALLS_PER_PHONE_PER_DAY verified/started calls per number
 *   within 24 h (all sources)
 * - global: DEMO_DAILY_LIMIT verified public demos within 24 h
 */
export async function checkDemoCaps(
  admin: SupabaseClient,
  phoneE164: string,
  options: { stage: 'request' | 'verified' }
): Promise<DemoCapVerdict> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  if (options.stage === 'request') {
    const { count: requestCount, error: requestError } = await admin
      .from('demo_calls')
      .select('id', { count: 'exact', head: true })
      .eq('phone_e164', phoneE164)
      .eq('source', 'public')
      .gte('created_at', since);
    if (requestError) return 'db_error';
    if ((requestCount ?? 0) >= DEMO_MAX_REQUESTS_PER_PHONE_PER_DAY) return 'request_limit';
  }

  const { count: phoneCount, error: phoneError } = await admin
    .from('demo_calls')
    .select('id', { count: 'exact', head: true })
    .eq('phone_e164', phoneE164)
    .gte('created_at', since)
    .not('status', 'in', '(awaiting_confirmation,expired)');
  if (phoneError) return 'db_error';
  if ((phoneCount ?? 0) >= DEMO_MAX_CALLS_PER_PHONE_PER_DAY) return 'phone_limit';

  const { count: dayCount, error: dayError } = await admin
    .from('demo_calls')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'public')
    .gte('confirmed_at', since);
  if (dayError) return 'db_error';
  if ((dayCount ?? 0) >= demoDailyLimit()) return 'daily_limit';
  return 'ok';
}

export function isDemoStatus(value: unknown): value is DemoStatus {
  return typeof value === 'string' && (DEMO_STATUSES as readonly string[]).includes(value);
}

/** Columns the verify/resend/status routes need — never lead data beyond the number. */
export interface DemoVerifyRow {
  id: string;
  status: DemoStatus;
  phone_e164: string;
  verify_channel: 'sms' | 'call' | null;
  verify_sends: number;
  verify_last_sent_at: string | null;
  verify_attempts: number;
  verify_expires_at: string | null;
}

const VERIFY_ROW_COLUMNS =
  'id, status, phone_e164, verify_channel, verify_sends, verify_last_sent_at, verify_attempts, verify_expires_at';

/** Looks a public request up by its (plain) status token. */
export async function loadDemoByStatusToken(
  admin: SupabaseClient,
  token: string
): Promise<{ row: DemoVerifyRow | null; error: boolean }> {
  const { data, error } = await admin
    .from('demo_calls')
    .select(VERIFY_ROW_COLUMNS)
    .eq('status_token_hash', hashDemoToken(token))
    .maybeSingle();
  if (error) return { row: null, error: true };
  const row = data as DemoVerifyRow | null;
  if (!row || !isDemoStatus(row.status)) return { row: null, error: false };
  return { row, error: false };
}

/** An unverified request past its verification window (the worker sweeps these lazily). */
export function isVerifyExpired(row: Pick<DemoVerifyRow, 'status' | 'verify_expires_at'>): boolean {
  return (
    row.status === 'awaiting_confirmation' &&
    row.verify_expires_at !== null &&
    Date.parse(row.verify_expires_at) < Date.now()
  );
}

/** Closes an unverified request for good (expired window, too many wrong codes, cap). */
export async function closeUnverifiedDemo(
  admin: SupabaseClient,
  id: string,
  detail: string
): Promise<void> {
  await admin
    .from('demo_calls')
    .update({ status: 'expired', status_detail: detail })
    .eq('id', id)
    .eq('status', 'awaiting_confirmation');
}

/** HTTP answer for a failed code delivery (request + resend routes). */
export const DEMO_SEND_FAILURES: Record<
  DemoVerifySendFailure,
  { status: number; code: string; error: string; phoneField: boolean }
> = {
  landline: {
    status: 400,
    code: 'invalid_number',
    error: 'An diese Nummer können wir keinen Code senden. Bitte prüf die Nummer.',
    phoneField: true,
  },
  invalid_number: {
    status: 400,
    code: 'invalid_number',
    error: 'An diese Nummer können wir keinen Code senden. Bitte prüf die Nummer.',
    phoneField: true,
  },
  blocked: {
    status: 400,
    code: 'blocked',
    error: 'An diese Nummer können wir leider keinen Code senden. Bitte nutze eine andere Nummer.',
    phoneField: true,
  },
  rate_limited: {
    status: 429,
    code: 'rate_limited',
    error: 'Für diese Nummer wurden gerade zu viele Codes angefordert. Bitte warte einige Minuten.',
    phoneField: false,
  },
  unavailable: {
    status: 503,
    code: 'unavailable',
    error: 'Der Code konnte gerade nicht gesendet werden. Bitte versuch es gleich erneut.',
    phoneField: false,
  },
};
