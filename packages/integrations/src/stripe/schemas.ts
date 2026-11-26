// zod shapes of the Stripe objects Zendori reads (Phase 15). Only the fields we
// use are declared; everything else passes through unparsed and unused.
import { z } from 'zod';

/** A reference Stripe returns as an id, or as the object when it was expanded. */
const idOrObject = z.union([z.string(), z.looseObject({ id: z.string() })]);

export function stripeRefId(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

export const stripeAccountSchema = z.looseObject({
  id: z.string().min(1),
  country: z.string().nullish(),
});
export type StripeAccount = z.infer<typeof stripeAccountSchema>;

export const stripePaymentMethodSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string(),
  customer: idOrObject.nullish(),
  card: z.looseObject({ brand: z.string().nullish(), last4: z.string().nullish() }).nullish(),
  sepa_debit: z.looseObject({ last4: z.string().nullish() }).nullish(),
});
export type StripePaymentMethod = z.infer<typeof stripePaymentMethodSchema>;

export const stripeCustomerSchema = z.looseObject({
  id: z.string().min(1),
  /** Present (true) on a customer that was deleted in Stripe. */
  deleted: z.boolean().optional(),
  livemode: z.boolean().optional(),
  tax_exempt: z.enum(['none', 'exempt', 'reverse']).nullish(),
  invoice_settings: z
    .looseObject({
      default_payment_method: z.union([z.string(), stripePaymentMethodSchema]).nullish(),
    })
    .nullish(),
});
export type StripeCustomer = z.infer<typeof stripeCustomerSchema>;

export const stripeTaxIdSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string(),
  value: z.string(),
  verification: z.looseObject({ status: z.string().nullish() }).nullish(),
});
export type StripeTaxId = z.infer<typeof stripeTaxIdSchema>;

export function stripeListSchema<T extends z.ZodType>(item: T) {
  return z.looseObject({ data: z.array(item), has_more: z.boolean().optional() });
}

export const stripeDeletedSchema = z.looseObject({
  id: z.string().min(1),
  deleted: z.boolean().optional(),
});

export const stripeSetupIntentSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  customer: idOrObject.nullish(),
  payment_method: idOrObject.nullish(),
});
export type StripeSetupIntent = z.infer<typeof stripeSetupIntentSchema>;

export const stripeCheckoutSessionSchema = z.looseObject({
  id: z.string().min(1),
  mode: z.string(),
  status: z.string().nullish(),
  /** The Stripe-hosted page; null once the session is complete or expired. */
  url: z.string().nullish(),
  customer: idOrObject.nullish(),
  setup_intent: z.union([z.string(), stripeSetupIntentSchema]).nullish(),
  livemode: z.boolean().optional(),
});
export type StripeCheckoutSession = z.infer<typeof stripeCheckoutSessionSchema>;

export const stripeMandateSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().nullish(),
  payment_method: idOrObject.nullish(),
});
export type StripeMandate = z.infer<typeof stripeMandateSchema>;

/**
 * A webhook event. Only the envelope and the ids inside `data.object` are read:
 * events are a signal to fetch the current object, never the source of a value.
 */
export const stripeEventSchema = z.looseObject({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(100),
  livemode: z.boolean(),
  data: z.looseObject({
    object: z.looseObject({
      id: z.string().max(255).optional(),
      object: z.string().max(100).optional(),
      customer: idOrObject.nullish(),
    }),
  }),
});
export type StripeEvent = z.infer<typeof stripeEventSchema>;
