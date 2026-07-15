// Twilio call recording for voice channels with recordingEnabled (Phase 9).
//
// Per-call recording via the Calls API (NOT trunk-wide recording): only calls
// on channels whose owner opted in are ever recorded, and the session speaks a
// mandatory notice first (§201 StGB: both-party consent). The post-call job
// moves the audio to Supabase Storage (EU) and deletes it at Twilio so the
// US-stored copy is transient (§7).
//
// Credentials are the operator-level TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN from
// the worker env — recording is cleanly disabled when they are absent.

export interface TwilioRecordingCreds {
  accountSid: string;
  authToken: string;
}

const TWILIO_BASE = (): string =>
  process.env.TWILIO_API_BASE?.replace(/\/+$/, '') || 'https://api.twilio.com';

function authHeader(creds: TwilioRecordingCreds): string {
  return `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`;
}

/**
 * Starts a dual-channel recording on the live inbound call leg. Returns the
 * recording SID. Throws on any non-2xx (callers treat recording as
 * best-effort and must not fail the call).
 */
export async function startCallRecording(
  creds: TwilioRecordingCreds,
  twilioCallSid: string
): Promise<string> {
  const res = await fetch(
    `${TWILIO_BASE()}/2010-04-01/Accounts/${creds.accountSid}/Calls/${twilioCallSid}/Recordings.json`,
    {
      method: 'POST',
      headers: {
        Authorization: authHeader(creds),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ RecordingChannels: 'dual' }).toString(),
    }
  );
  if (!res.ok) {
    throw new Error(`Twilio start recording → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { sid?: string };
  if (!body.sid) throw new Error('Twilio start recording returned no sid');
  return body.sid;
}

/**
 * Downloads the finished recording as WAV. Returns null while Twilio is still
 * processing it (404) so the caller can retry shortly; throws on other errors.
 */
export async function fetchRecordingWav(
  creds: TwilioRecordingCreds,
  recordingSid: string
): Promise<Uint8Array | null> {
  const res = await fetch(
    `${TWILIO_BASE()}/2010-04-01/Accounts/${creds.accountSid}/Recordings/${recordingSid}.wav`,
    { headers: { Authorization: authHeader(creds) } }
  );
  if (res.status === 404) return null; // still processing
  if (!res.ok) {
    throw new Error(`Twilio fetch recording → ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Deletes the recording (and its media) at Twilio. Best-effort for callers. */
export async function deleteRecording(
  creds: TwilioRecordingCreds,
  recordingSid: string
): Promise<void> {
  const res = await fetch(
    `${TWILIO_BASE()}/2010-04-01/Accounts/${creds.accountSid}/Recordings/${recordingSid}.json`,
    { method: 'DELETE', headers: { Authorization: authHeader(creds) } }
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`Twilio delete recording → ${res.status}`);
  }
}
