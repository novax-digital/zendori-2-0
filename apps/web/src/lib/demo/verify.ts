import 'server-only';
import { z } from 'zod';
import {
  classifyVerifyCheck,
  classifyVerifySendError,
  type DemoVerifyChannel,
  type DemoVerifyCheckResult,
  type DemoVerifySendFailure,
} from '@zendori/core';

// Twilio Verify client for the public Demo-Anruf (0032): sends the 6-digit
// code by SMS (mobile) or by a voice call reading it out (landline) and checks
// it. Twilio generates, stores and expires the code — Zendori never sees it
// except when the visitor types it in. Plain REST (no SDK dependency), every
// response zod-parsed. Phone numbers never go to the logs (§7).
//
// Env (Vercel): DEMO_VERIFY_SERVICE_SID (VA…) + DEMO_TWILIO_API_KEY_SID /
// DEMO_TWILIO_API_KEY_SECRET (an API key SK… — or Account SID + Auth Token).

const VERIFY_BASE = 'https://verify.twilio.com/v2';

const errorBodySchema = z.object({ code: z.number().nullish(), message: z.string().nullish() });
const verificationSchema = z.object({ status: z.string().nullish() });

interface VerifyConfig {
  serviceSid: string;
  authHeader: string;
}

function verifyConfig(): VerifyConfig | null {
  const serviceSid = process.env.DEMO_VERIFY_SERVICE_SID;
  const keySid = process.env.DEMO_TWILIO_API_KEY_SID;
  const keySecret = process.env.DEMO_TWILIO_API_KEY_SECRET;
  if (!serviceSid || !keySid || !keySecret) return null;
  return {
    serviceSid,
    authHeader: `Basic ${Buffer.from(`${keySid}:${keySecret}`).toString('base64')}`,
  };
}

/** True when the Verify env is complete — without it public demos cannot be verified. */
export function isDemoVerifyConfigured(): boolean {
  return verifyConfig() !== null;
}

async function post(
  config: VerifyConfig,
  path: string,
  params: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${VERIFY_BASE}/Services/${config.serviceSid}${path}`, {
    method: 'POST',
    headers: {
      Authorization: config.authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // non-JSON error page
  }
  return { status: response.status, body };
}

export type DemoVerifySendResult =
  | { ok: true; channel: DemoVerifyChannel }
  | { ok: false; reason: DemoVerifySendFailure };

/**
 * Starts (or restarts — Twilio then issues a fresh code) the verification.
 * An SMS to a number Twilio identifies as landline is retried once as a call.
 */
export async function sendDemoCode(
  e164: string,
  channel: DemoVerifyChannel
): Promise<DemoVerifySendResult> {
  const config = verifyConfig();
  if (!config) return { ok: false, reason: 'unavailable' };
  try {
    const { status, body } = await post(config, '/Verifications', {
      To: e164,
      Channel: channel,
      Locale: 'de',
    });
    if (status >= 200 && status < 300) return { ok: true, channel };
    const error = errorBodySchema.safeParse(body);
    const reason = classifyVerifySendError(status, error.success ? (error.data.code ?? null) : null);
    if (reason === 'landline' && channel === 'sms') return sendDemoCode(e164, 'call');
    return { ok: false, reason };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Checks a code typed in by the visitor. */
export async function checkDemoCode(e164: string, code: string): Promise<DemoVerifyCheckResult> {
  const config = verifyConfig();
  if (!config) return 'unavailable';
  try {
    const { status, body } = await post(config, '/VerificationCheck', { To: e164, Code: code });
    const ok = status >= 200 && status < 300;
    const parsed = ok ? verificationSchema.safeParse(body) : errorBodySchema.safeParse(body);
    const data = parsed.success ? (parsed.data as { status?: string | null; code?: number | null }) : null;
    return classifyVerifyCheck(status, data);
  } catch {
    return 'unavailable';
  }
}
