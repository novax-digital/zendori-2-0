// Demo-Anruf (0032): outbound leg via Twilio Programmable Voice. xAI cannot
// originate calls, so Twilio dials the lead and — once answered — bridges via
// <Dial><Sip> to the operator's demo number at xAI. xAI sees an ordinary
// incoming SIP call (webhook → /api/hooks/demo/voice) and the worker joins it
// exactly like a Phase-9 inbound call. Operator-level credentials
// (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN); never logs numbers (§7).

export interface TwilioCreds {
  accountSid: string;
  authToken: string;
}

/**
 * SIP URI params for the bridge leg. TLS signaling + SRTP media mirror the
 * Phase-9 trunk requirements (without SRTP xAI produced dead air, 2026-07-15).
 * Overridable via DEMO_SIP_PARAMS for the live gate without a redeploy.
 */
export const DEFAULT_DEMO_SIP_PARAMS = ';transport=tls;secure=true';
export const XAI_SIP_HOST = 'sip.voice.x.ai';

/** Seconds Twilio lets the lead's phone ring before giving up (no-answer). */
export const DEMO_RING_TIMEOUT_SECONDS = 30;

const API_BASE = (): string =>
  process.env.TWILIO_API_BASE?.replace(/\/+$/, '') || 'https://api.twilio.com';

function authHeader(creds: TwilioCreds): string {
  return `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * TwiML executed when the lead answers: bridge to the demo number at xAI.
 * The demo row id travels as a custom SIP header (Twilio: "X-" query params on
 * the <Sip> URI become headers) so the webhook can match the call exactly.
 */
export function buildDemoTwiml(params: {
  demoNumber: string;
  demoCallId: string;
  sipParams: string;
  timeLimitSeconds: number;
}): string {
  const uri = `sip:${params.demoNumber}@${XAI_SIP_HOST}${params.sipParams}?X-Zendori-Demo=${params.demoCallId}`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Dial timeLimit="${params.timeLimitSeconds}" timeout="20">` +
    `<Sip>${escapeXml(uri)}</Sip></Dial></Response>`
  );
}

export type DemoDialFailure = 'invalid_number' | 'geo_permission' | 'dial_failed';

export class TwilioCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    readonly failure: DemoDialFailure
  ) {
    super(`Twilio call request failed (status ${status}, code ${code ?? 'n/a'})`);
    this.name = 'TwilioCallError';
  }
}

/** Twilio error code → demo failure detail (shown in the admin list). */
export function classifyTwilioError(code: number | null): DemoDialFailure {
  if (code === 21211 || code === 21214 || code === 13224 || code === 21217) return 'invalid_number';
  if (code === 21215 || code === 21216) return 'geo_permission';
  return 'dial_failed';
}

async function twilioError(res: Response): Promise<TwilioCallError> {
  let code: number | null = null;
  try {
    const body = (await res.json()) as { code?: unknown };
    code = typeof body.code === 'number' ? body.code : null;
  } catch {
    /* non-JSON error body */
  }
  return new TwilioCallError(res.status, code, classifyTwilioError(code));
}

/** Starts the outbound call. Returns the parent CallSid. */
export async function createDemoCall(
  creds: TwilioCreds,
  params: { to: string; from: string; twiml: string; timeLimitSeconds: number }
): Promise<{ sid: string }> {
  const body = new URLSearchParams({
    To: params.to,
    From: params.from,
    Twiml: params.twiml,
    Timeout: String(DEMO_RING_TIMEOUT_SECONDS),
    TimeLimit: String(params.timeLimitSeconds),
  });
  const res = await fetch(`${API_BASE()}/2010-04-01/Accounts/${creds.accountSid}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(creds),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) throw await twilioError(res);
  const json = (await res.json()) as { sid?: unknown };
  if (typeof json.sid !== 'string') throw new TwilioCallError(res.status, null, 'dial_failed');
  return { sid: json.sid };
}

export type TwilioCallStatus =
  | 'queued'
  | 'initiated'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'busy'
  | 'no-answer'
  | 'failed'
  | 'canceled';

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'initiated',
  'ringing',
  'in-progress',
  'completed',
  'busy',
  'no-answer',
  'failed',
  'canceled',
]);

export async function fetchDemoCallStatus(
  creds: TwilioCreds,
  callSid: string
): Promise<TwilioCallStatus | null> {
  const res = await fetch(
    `${API_BASE()}/2010-04-01/Accounts/${creds.accountSid}/Calls/${encodeURIComponent(callSid)}.json`,
    { headers: { Authorization: authHeader(creds) } }
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { status?: unknown };
  return typeof json.status === 'string' && KNOWN_STATUSES.has(json.status)
    ? (json.status as TwilioCallStatus)
    : null;
}

/** Hangs up / cancels the call (completed also cancels a still-ringing call). */
export async function endDemoCall(creds: TwilioCreds, callSid: string): Promise<void> {
  await fetch(
    `${API_BASE()}/2010-04-01/Accounts/${creds.accountSid}/Calls/${encodeURIComponent(callSid)}.json`,
    {
      method: 'POST',
      headers: {
        Authorization: authHeader(creds),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Status: 'completed' }).toString(),
    }
  );
}

/**
 * What a polled Twilio status means for a row still in 'dialing' (the xAI
 * webhook has not arrived yet). null = keep waiting.
 */
export function dialingOutcome(
  status: TwilioCallStatus
): { status: 'no_answer' | 'busy' | 'failed'; detail: string } | null {
  switch (status) {
    case 'busy':
      return { status: 'busy', detail: 'busy' };
    case 'no-answer':
      return { status: 'no_answer', detail: 'no_answer' };
    case 'failed':
      return { status: 'failed', detail: 'twilio_failed' };
    case 'canceled':
      return { status: 'failed', detail: 'canceled' };
    case 'completed':
      // answered, but the call ended before xAI announced the bridged leg:
      // lead hung up immediately or the SIP bridge was refused (live gate)
      return { status: 'failed', detail: 'ended_before_connect' };
    default:
      return null;
  }
}
