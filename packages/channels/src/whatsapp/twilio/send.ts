import { z } from 'zod';

// Minimal Twilio Messages REST client (no SDK — same convention as email/send.ts).
// Sends WhatsApp freeform text (inside the 24h window) or an approved Content
// template (outside it). Reads TWILIO_API_BASE for local stub testing.
// Never logs the auth token, recipient or message content (§7).

const DEFAULT_API_BASE = 'https://api.twilio.com';

/** Thrown when a Twilio request fails or its response is malformed. */
export class TwilioApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TwilioApiError';
  }
}

function apiBase(): string {
  const configured = process.env.TWILIO_API_BASE?.trim();
  return configured && configured.length > 0 ? configured.replace(/\/+$/, '') : DEFAULT_API_BASE;
}

const twilioSendResponseSchema = z.object({
  sid: z.string().min(1),
  status: z.string().optional(),
});

export interface SendTwilioWhatsAppParams {
  accountSid: string;
  authToken: string;
  /** "+E164" sender; either this or messagingServiceSid must be set. */
  sender?: string;
  messagingServiceSid?: string;
  /** Recipient "+E164" (without the whatsapp: prefix — added here). */
  to: string;
  /** Freeform text (in-window). Mutually exclusive with contentSid. */
  body?: string;
  /** Approved Content template SID (out-of-window). */
  contentSid?: string;
  /** JSON-string map of the template's numbered placeholders. */
  contentVariables?: string;
}

/**
 * Sends a WhatsApp message via Twilio's Messages API. Returns the message SID
 * (used as the outbound external id + to match delivery-status callbacks).
 */
export async function sendTwilioWhatsApp(
  params: SendTwilioWhatsAppParams
): Promise<{ sid: string }> {
  const { accountSid, authToken, sender, messagingServiceSid, to, body, contentSid } = params;

  const form = new URLSearchParams();
  form.set('To', `whatsapp:${to}`);
  if (messagingServiceSid) {
    form.set('MessagingServiceSid', messagingServiceSid);
  } else if (sender) {
    form.set('From', `whatsapp:${sender}`);
  } else {
    throw new TwilioApiError('neither sender nor messagingServiceSid configured');
  }
  if (contentSid) {
    form.set('ContentSid', contentSid);
    if (params.contentVariables) form.set('ContentVariables', params.contentVariables);
  } else {
    form.set('Body', body ?? '');
  }

  const url = `${apiBase()}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`, 'utf8').toString('base64');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
  } catch (cause) {
    throw new TwilioApiError('twilio send request failed', { cause });
  }

  if (!res.ok) {
    // Read the Twilio error code without leaking content, so the caller can map
    // e.g. 63016 (outside 24h window) to a handoff/agent notice.
    let code: number | undefined;
    try {
      const errJson = (await res.json()) as { code?: number };
      code = typeof errJson.code === 'number' ? errJson.code : undefined;
    } catch {
      /* ignore parse failure */
    }
    throw new TwilioApiError(
      `twilio send returned status ${res.status}${code ? ` (code ${code})` : ''}`
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (cause) {
    throw new TwilioApiError('could not parse twilio send response', { cause });
  }
  const parsed = twilioSendResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new TwilioApiError('twilio send response did not match schema');
  }
  return { sid: parsed.data.sid };
}
