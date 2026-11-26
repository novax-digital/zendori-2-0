// Which Stripe events Zendori keeps, and what they point at (Phase 15).
//
// An event is only a signal: the webhook route stores its id and the ids of the
// object it is about, the worker then reads the CURRENT object from Stripe.
// Stripe gives no ordering guarantee, so no value is ever taken from an event.
import { stripeRefId, type StripeEvent } from './schemas.js';

/** Events about the customer, its tax id and its payment method (15a). */
export const STRIPE_ACCOUNT_EVENT_TYPES = [
  'checkout.session.completed',
  // a SEPA setup can finish a moment after the Checkout session completed
  'setup_intent.succeeded',
  'customer.updated',
  'customer.deleted',
  'customer.tax_id.created',
  'customer.tax_id.updated',
  'customer.tax_id.deleted',
  'payment_method.attached',
  'payment_method.detached',
  'payment_method.updated',
  'payment_method.automatically_updated',
  'mandate.updated',
] as const;

/**
 * Events about the charge of an invoice (15b step 3). The endpoint in Stripe
 * has to subscribe to them; docs/phase-15b-rechnungen.md has the command.
 */
export const STRIPE_PAYMENT_EVENT_TYPES = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.canceled',
  // a SEPA debit or a card payment is reversed after it went through
  'charge.dispute.created',
] as const;

export type StripeEventScope = 'account' | 'payment';

/** null = an event Zendori does not act on (acknowledged, not stored). */
export function stripeEventScope(type: string): StripeEventScope | null {
  if ((STRIPE_ACCOUNT_EVENT_TYPES as readonly string[]).includes(type)) return 'account';
  if ((STRIPE_PAYMENT_EVENT_TYPES as readonly string[]).includes(type)) return 'payment';
  return null;
}

/** The content-free reference stored in stripe_events. */
export interface StripeEventRef {
  eventId: string;
  type: string;
  livemode: boolean;
  /** `data.object.object`, e.g. `customer`, `checkout.session`. */
  objectType: string | null;
  objectId: string | null;
  /** The customer the object belongs to (the object itself for customer events). */
  customerId: string | null;
}

export function stripeEventRef(event: StripeEvent): StripeEventRef {
  const object = event.data.object;
  const objectType = object.object ?? null;
  const objectId = object.id ?? null;
  const customerId = objectType === 'customer' ? objectId : stripeRefId(object.customer);
  return {
    eventId: event.id,
    type: event.type,
    livemode: event.livemode,
    objectType,
    objectId,
    customerId,
  };
}
