// Charging an invoice through Stripe (Phase 15b step 3). Zendori issues the
// invoice itself; Stripe only moves the money: one PaymentIntent per invoice,
// confirmed at once against the payment method the customer stored earlier
// (SEPA Direct Debit or card), without the customer being present.
//
// The idempotency key carries the invoice and the attempt, so a request that
// is repeated after a timeout can never charge twice. A new attempt (the
// operator asks again after a failure) uses a new key.
import { z } from 'zod';
import { isStripeNotFound, stripeCall, stripeId, type StripeConfig } from './client.js';
import { stripeListSchema } from './schemas.js';

export const STRIPE_INVOICE_METADATA_KEY = 'zendori_invoice_id';

const refSchema = z.union([z.string(), z.looseObject({ id: z.string() })]).nullish();

export const stripePaymentIntentSchema = z.looseObject({
  id: z.string(),
  /** requires_payment_method | requires_action | processing | succeeded | canceled | … */
  status: z.string(),
  amount: z.number(),
  currency: z.string(),
  customer: refSchema,
  payment_method: refSchema,
  metadata: z.record(z.string(), z.string()).nullish(),
  last_payment_error: z
    .looseObject({ code: z.string().nullish(), decline_code: z.string().nullish() })
    .nullish(),
});
export type StripePaymentIntent = z.infer<typeof stripePaymentIntentSchema>;

export const stripeDisputeSchema = z.looseObject({
  id: z.string(),
  payment_intent: refSchema,
  status: z.string().nullish(),
});
export type StripeDispute = z.infer<typeof stripeDisputeSchema>;

export function invoicePaymentIdempotencyKey(invoiceId: string, attempt: number): string {
  return `zinv:${invoiceId}:${attempt}`;
}

export interface InvoiceChargeInput {
  invoiceId: string;
  invoiceNumber: string;
  orgId: string | null;
  customerId: string;
  paymentMethodId: string;
  paymentMethodType: 'sepa_debit' | 'card';
  /** Gross amount in cents (EUR). */
  amountCents: number;
  /** 0 for the first charge of an invoice, counted up when the operator asks again. */
  attempt: number;
}

/**
 * Creates and confirms the PaymentIntent of an invoice. Stripe answers with the
 * intent (`succeeded` for a card, `processing` for a SEPA debit) or — for a
 * declined card — with an error (status 402) that the caller turns into a
 * failed charge. Only the invoice number and ids travel as description and
 * metadata; no line items, no customer data.
 */
export async function createInvoicePaymentIntent(
  config: StripeConfig,
  input: InvoiceChargeInput
): Promise<StripePaymentIntent> {
  return stripeCall(config, stripePaymentIntentSchema, 'POST', '/v1/payment_intents', {
    params: {
      amount: input.amountCents,
      currency: 'eur',
      customer: input.customerId,
      payment_method: input.paymentMethodId,
      payment_method_types: [input.paymentMethodType],
      off_session: true,
      confirm: true,
      description: `Rechnung ${input.invoiceNumber}`,
      metadata: {
        [STRIPE_INVOICE_METADATA_KEY]: input.invoiceId,
        zendori_invoice_number: input.invoiceNumber,
        zendori_collect_attempt: String(input.attempt),
        ...(input.orgId ? { zendori_org_id: input.orgId } : {}),
      },
    },
    idempotencyKey: invoicePaymentIdempotencyKey(input.invoiceId, input.attempt),
  });
}

/**
 * The most recent PaymentIntents of a customer — to find a charge that was
 * created by a run that did not live to record it.
 */
export async function listCustomerPaymentIntents(
  config: StripeConfig,
  customerId: string
): Promise<StripePaymentIntent[]> {
  const list = await stripeCall(
    config,
    stripeListSchema(stripePaymentIntentSchema),
    'GET',
    '/v1/payment_intents',
    { query: { customer: customerId, limit: 100 } }
  );
  return list.data;
}

export async function retrievePaymentIntent(
  config: StripeConfig,
  paymentIntentId: string
): Promise<StripePaymentIntent | null> {
  try {
    return await stripeCall(
      config,
      stripePaymentIntentSchema,
      'GET',
      `/v1/payment_intents/${stripeId(paymentIntentId)}`
    );
  } catch (error) {
    if (isStripeNotFound(error)) return null;
    throw error;
  }
}

export async function retrieveDispute(
  config: StripeConfig,
  disputeId: string
): Promise<StripeDispute | null> {
  try {
    return await stripeCall(
      config,
      stripeDisputeSchema,
      'GET',
      `/v1/disputes/${stripeId(disputeId)}`
    );
  } catch (error) {
    if (isStripeNotFound(error)) return null;
    throw error;
  }
}
