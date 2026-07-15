// Twilio call recording for voice channels with recordingEnabled (Phase 9).
//
// Recording is done at the TRUNK level: incoming calls are Elastic SIP Trunking
// originations (type sip-pstn), which are NOT recordable via the per-call Voice
// API (`/Calls/{Sid}/Recordings` → 20404 "Call not found"). Instead the trunk's
// Recording sub-resource is set to dual-channel record-from-answer, and each
// call's recording then appears under the account's Recordings, looked up by
// CallSid. The session still speaks the mandatory §201 notice first. The
// post-call job moves the audio to Supabase Storage (EU) and deletes it at
// Twilio so the US-stored copy is transient (§7).
//
// Credentials are the operator-level TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN from
// the worker env — recording is cleanly disabled when they are absent.

export interface TwilioRecordingCreds {
  accountSid: string;
  authToken: string;
}

/** Dual-channel keeps caller and bot on separate tracks (§7: clean QA audio). */
export type TrunkRecordingMode =
  | 'do-not-record'
  | 'record-from-ringing-dual'
  | 'record-from-answer-dual';

const TWILIO_BASE = (): string =>
  process.env.TWILIO_API_BASE?.replace(/\/+$/, '') || 'https://api.twilio.com';

const TRUNKING_BASE = (): string =>
  process.env.TWILIO_TRUNKING_API_BASE?.replace(/\/+$/, '') || 'https://trunking.twilio.com';

function authHeader(creds: TwilioRecordingCreds): string {
  return `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`;
}

/**
 * Sets the recording mode on an Elastic SIP Trunk (trunk-wide: every call on
 * the trunk is recorded). Per-org opt-in therefore requires a trunk per org.
 * Throws on any non-2xx.
 */
export async function setTrunkRecording(
  creds: TwilioRecordingCreds,
  trunkSid: string,
  mode: TrunkRecordingMode
): Promise<void> {
  const res = await fetch(`${TRUNKING_BASE()}/v1/Trunks/${trunkSid}/Recording`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(creds),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ Mode: mode, Trim: 'do-not-trim' }).toString(),
  });
  if (!res.ok) {
    throw new Error(`Twilio set trunk recording → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * Finds the recording SID for a call (trunk recordings surface under the
 * account's Recordings, filterable by CallSid). Returns null when Twilio has
 * not listed it yet, so the caller can retry shortly. Throws on other errors.
 */
export async function findRecordingSidByCall(
  creds: TwilioRecordingCreds,
  callSid: string
): Promise<string | null> {
  const res = await fetch(
    `${TWILIO_BASE()}/2010-04-01/Accounts/${creds.accountSid}/Recordings.json?CallSid=${encodeURIComponent(
      callSid
    )}&PageSize=1`,
    { headers: { Authorization: authHeader(creds) } }
  );
  if (!res.ok) {
    throw new Error(`Twilio list recordings → ${res.status}`);
  }
  const body = (await res.json()) as { recordings?: { sid?: string }[] };
  return body.recordings?.[0]?.sid ?? null;
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
