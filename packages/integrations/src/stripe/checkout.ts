// Stripe Checkout in setup mode (Phase 15a): the customer stores a payment
// method on Stripe's own page. Zendori never sees an IBAN or a card number —
// only the type and the last four digits that Stripe reports afterwards.
import { stripeCall, stripeId, type StripeConfig } from './client.js';
import { STRIPE_ORG_METADATA_KEY } from './customers.js';
import { stripeCheckoutSessionSchema, type StripeCheckoutSession } from './schemas.js';

/** What a customer may store. Filters the methods enabled in the Stripe account. */
export const SETUP_PAYMENT_METHOD_TYPES = ['sepa_debit', 'card'] as const;

export async function createSetupCheckoutSession(
  config: StripeConfig,
  input: { customerId: string; orgId: string; successUrl: string; cancelUrl: string }
): Promise<StripeCheckoutSession> {
  return stripeCall(config, stripeCheckoutSessionSchema, 'POST', '/v1/checkout/sessions', {
    params: {
      mode: 'setup',
      customer: input.customerId,
      currency: 'eur',
      allowed_payment_method_types: [...SETUP_PAYMENT_METHOD_TYPES],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      locale: 'de',
      client_reference_id: input.orgId,
      metadata: { [STRIPE_ORG_METADATA_KEY]: input.orgId },
    },
  });
}

/** The session with its SetupIntent expanded (carries the payment method id). */
export async function retrieveCheckoutSession(
  config: StripeConfig,
  sessionId: string
): Promise<StripeCheckoutSession> {
  return stripeCall(
    config,
    stripeCheckoutSessionSchema,
    'GET',
    `/v1/checkout/sessions/${stripeId(sessionId)}`,
    { query: { expand: ['setup_intent'] } }
  );
}
