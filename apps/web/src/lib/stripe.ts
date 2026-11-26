import 'server-only';
import {
  parseStripeWebhookSecrets,
  stripeKeyLivemode,
  type StripeConfig,
} from '@zendori/integrations';

// Stripe configuration of the web app (Phase 15). Read lazily per request, like
// the other optional integrations: without STRIPE_SECRET_KEY every page behaves
// exactly as before.

export interface StripeRuntime {
  config: StripeConfig;
  /** false = test mode, true = live — read from the key's prefix. */
  livemode: boolean;
}

/** null when Stripe is not configured (or the value is not a secret key). */
export function stripeRuntime(): StripeRuntime | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  const livemode = stripeKeyLivemode(secretKey);
  if (livemode === null) return null;
  return { config: { secretKey }, livemode };
}

/** Signing secrets of the webhook endpoint(s); comma-separated in the env. */
export function stripeWebhookSecrets(): string[] {
  return parseStripeWebhookSecrets(process.env.STRIPE_WEBHOOK_SECRET);
}
