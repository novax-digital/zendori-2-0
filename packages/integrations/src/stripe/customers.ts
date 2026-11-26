// Stripe customer, tax id and payment-method calls (Phase 15a).
//
// A Zendori organization has at most one Stripe customer per mode (test/live).
// It is created with nothing but the org id in its metadata, so web and worker
// can both send the creating request with the same idempotency key and get the
// same customer back; the details follow in a separate update.
import type { z } from 'zod';
import {
  isStripeNotFound,
  stripeCall,
  stripeId,
  stripeRequest,
  type StripeConfig,
  type StripeParams,
} from './client.js';
import {
  stripeAccountSchema,
  stripeCustomerSchema,
  stripeListSchema,
  stripeMandateSchema,
  stripePaymentMethodSchema,
  stripeSetupIntentSchema,
  stripeTaxIdSchema,
  type StripeAccount,
  type StripeCustomer,
  type StripeMandate,
  type StripePaymentMethod,
  type StripeSetupIntent,
  type StripeTaxId,
} from './schemas.js';

/** Metadata key that ties a Stripe customer to its organization. */
export const STRIPE_ORG_METADATA_KEY = 'zendori_org_id';
/** Stripe's type for EU VAT numbers. */
export const STRIPE_EU_VAT_TYPE = 'eu_vat';

/** The account the key belongs to — tells two sandboxes apart. */
export async function retrieveStripeAccount(config: StripeConfig): Promise<StripeAccount> {
  return stripeCall(config, stripeAccountSchema, 'GET', '/v1/account');
}

/**
 * Idempotency key of the creating request. `generation` (stored in the row,
 * billing_stripe_customers.customer_generation) is counted up only when a
 * customer that was deleted in Stripe has to be created again — with the old
 * key Stripe would replay the deleted customer for a day.
 */
export function customerIdempotencyKey(orgId: string, generation: number): string {
  return `zcus:${orgId}:${generation}`;
}

export async function createStripeCustomer(
  config: StripeConfig,
  input: { orgId: string; generation: number }
): Promise<StripeCustomer> {
  return stripeCall(config, stripeCustomerSchema, 'POST', '/v1/customers', {
    params: { metadata: { [STRIPE_ORG_METADATA_KEY]: input.orgId } },
    idempotencyKey: customerIdempotencyKey(input.orgId, input.generation),
  });
}

export interface StripeCustomerDetails {
  name: string;
  email: string;
  address: {
    line1: string;
    line2: string | null;
    postalCode: string;
    city: string;
    country: string;
  };
  taxExempt: 'none' | 'reverse';
}

/** Name, address and tax flag of an existing customer (German invoices). */
export async function updateStripeCustomer(
  config: StripeConfig,
  customerId: string,
  details: StripeCustomerDetails
): Promise<StripeCustomer> {
  const params: StripeParams = {
    name: details.name,
    email: details.email,
    address: {
      line1: details.address.line1,
      // null unsets a line that was removed
      line2: details.address.line2,
      postal_code: details.address.postalCode,
      city: details.address.city,
      country: details.address.country,
    },
    preferred_locales: ['de'],
    tax_exempt: details.taxExempt,
  };
  return stripeCall(config, stripeCustomerSchema, 'POST', `/v1/customers/${stripeId(customerId)}`, {
    params,
  });
}

/**
 * The customer with its default payment method expanded; null when it does not
 * exist for this key or was deleted in Stripe.
 */
export async function retrieveStripeCustomer(
  config: StripeConfig,
  customerId: string
): Promise<StripeCustomer | null> {
  try {
    const customer = await stripeCall(
      config,
      stripeCustomerSchema,
      'GET',
      `/v1/customers/${stripeId(customerId)}`,
      { query: { expand: ['invoice_settings.default_payment_method'] } }
    );
    return customer.deleted ? null : customer;
  } catch (error) {
    if (isStripeNotFound(error)) return null;
    throw error;
  }
}

/** Checkout in setup mode attaches the method but does not make it the default. */
export async function setDefaultPaymentMethod(
  config: StripeConfig,
  customerId: string,
  paymentMethodId: string
): Promise<StripeCustomer> {
  return stripeCall(config, stripeCustomerSchema, 'POST', `/v1/customers/${stripeId(customerId)}`, {
    params: { invoice_settings: { default_payment_method: paymentMethodId } },
  });
}

export async function retrieveSetupIntent(
  config: StripeConfig,
  setupIntentId: string
): Promise<StripeSetupIntent> {
  return stripeCall(
    config,
    stripeSetupIntentSchema,
    'GET',
    `/v1/setup_intents/${stripeId(setupIntentId)}`
  );
}

export async function retrievePaymentMethod(
  config: StripeConfig,
  paymentMethodId: string
): Promise<StripePaymentMethod | null> {
  try {
    return await stripeCall(
      config,
      stripePaymentMethodSchema,
      'GET',
      `/v1/payment_methods/${stripeId(paymentMethodId)}`
    );
  } catch (error) {
    if (isStripeNotFound(error)) return null;
    throw error;
  }
}

export async function retrieveMandate(
  config: StripeConfig,
  mandateId: string
): Promise<StripeMandate | null> {
  try {
    return await stripeCall(
      config,
      stripeMandateSchema,
      'GET',
      `/v1/mandates/${stripeId(mandateId)}`
    );
  } catch (error) {
    if (isStripeNotFound(error)) return null;
    throw error;
  }
}

// --- tax ids -----------------------------------------------------------------

const taxIdListSchema: z.ZodType<{ data: StripeTaxId[] }> = stripeListSchema(stripeTaxIdSchema);

export async function listCustomerTaxIds(
  config: StripeConfig,
  customerId: string
): Promise<StripeTaxId[]> {
  const list = await stripeCall(
    config,
    taxIdListSchema,
    'GET',
    `/v1/customers/${stripeId(customerId)}/tax_ids`,
    { query: { limit: 100 } }
  );
  return list.data;
}

/**
 * Makes `vatId` the customer's one EU VAT id (null/empty: none). Stripe checks a
 * tax id once when it is created and cannot change one, so a different value
 * means delete + create; an unchanged value is left alone (its check stands).
 * Returns the tax id that is on the customer afterwards.
 */
export async function syncCustomerVatId(
  config: StripeConfig,
  customerId: string,
  vatId: string | null
): Promise<StripeTaxId | null> {
  const wanted = vatId && vatId.length > 0 ? vatId : null;
  const existing = (await listCustomerTaxIds(config, customerId)).filter(
    (taxId) => taxId.type === STRIPE_EU_VAT_TYPE
  );
  let kept: StripeTaxId | null = null;
  for (const taxId of existing) {
    if (wanted !== null && kept === null && taxId.value === wanted) {
      kept = taxId;
      continue;
    }
    try {
      await stripeRequest(
        config,
        'DELETE',
        `/v1/customers/${stripeId(customerId)}/tax_ids/${stripeId(taxId.id)}`
      );
    } catch (error) {
      // already gone (a parallel run deleted it) is the wanted state
      if (!isStripeNotFound(error)) throw error;
    }
  }
  if (wanted === null || kept !== null) return kept;
  // No idempotency key on purpose: a key would replay a tax id that was deleted
  // again in the meantime (A → B → A within a day). Without a key the client
  // never repeats this POST, and a second run finds the value in the list above.
  return stripeCall(
    config,
    stripeTaxIdSchema,
    'POST',
    `/v1/customers/${stripeId(customerId)}/tax_ids`,
    { params: { type: STRIPE_EU_VAT_TYPE, value: wanted } }
  );
}
