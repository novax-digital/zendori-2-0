import 'server-only';
import { Webhook } from 'svix';

/**
 * Resend signs inbound webhooks with Svix. Verification MUST run on the raw
 * request body with the three svix-* headers and RESEND_WEBHOOK_SECRET.
 */

/** Thrown when RESEND_WEBHOOK_SECRET is missing → the route answers 503 (not a client error). */
export class ResendWebhookNotConfiguredError extends Error {
  constructor() {
    super('RESEND_WEBHOOK_SECRET is not configured');
    this.name = 'ResendWebhookNotConfiguredError';
  }
}

/** Thrown when the signature is missing or invalid → the route answers 401. */
export class ResendWebhookVerificationError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Resend webhook signature verification failed', options);
    this.name = 'ResendWebhookVerificationError';
  }
}

/**
 * Verifies a Resend (Svix) webhook. Returns the parsed payload on success.
 * Throws ResendWebhookNotConfiguredError if the secret is unset, otherwise
 * ResendWebhookVerificationError on any signature problem.
 */
export function verifyResendWebhook(rawBody: string, headers: Headers): unknown {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    throw new ResendWebhookNotConfiguredError();
  }

  const svixId = headers.get('svix-id');
  const svixTimestamp = headers.get('svix-timestamp');
  const svixSignature = headers.get('svix-signature');
  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new ResendWebhookVerificationError();
  }

  try {
    return new Webhook(secret).verify(rawBody, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    });
  } catch (cause) {
    throw new ResendWebhookVerificationError({ cause });
  }
}
