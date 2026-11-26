'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  billingDetailsErrorMessage,
  billingDetailsSchema,
  canViewArea,
  createLogger,
  isAdminRole,
} from '@zendori/core';
import {
  StripeCustomerRowMissingError,
  createSetupCheckoutSession,
  ensureStripeCustomerId,
  stripeErrorCode,
} from '@zendori/integrations';
import { appUrl } from '@/lib/env';
import { href } from '@/lib/href';
import { requireActiveOrg } from '@/lib/org';
import { checkRateLimit } from '@/lib/rate-limit';
import { stripeRuntime } from '@/lib/stripe';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  billingDetailsFromForm,
  loadBillingAccountState,
  saveBillingDetailsRow,
} from '@/lib/billing-account';

// Customer side of Stripe billing (Phase 15a): billing details and the payment
// method. Both are for the owner / an admin of the organization only, and only
// once the operator enabled Stripe billing for it. The web app writes Zendori's
// own tables; the one Stripe call here opens Stripe's payment page — everything
// else (pushing details, reading the payment method back) is the worker's job.

const log = createLogger('billing');

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pageUrl(org: string, params: Record<string, string | undefined> = {}): string {
  return href('/settings/billing', { org, ...params });
}

const NOT_AVAILABLE = 'Die Abrechnung über Stripe ist für diese Organisation nicht eingerichtet.';

/** The signed-in owner/admin of exactly this org, plus the enabled Stripe row. */
async function requireBillingEditor(org: string) {
  if (!z.uuid().safeParse(org).success) redirect('/settings/billing');
  const active = await requireActiveOrg(org, { strict: true });
  // requireActiveOrg falls back to the first membership — never act on another org
  if (active.orgId !== org || !isAdminRole(active.role)) {
    redirect(pageUrl(org, { error: 'Nur Inhaber und Admins können die Abrechnung ändern.' }));
  }
  const runtime = stripeRuntime();
  const admin = createSupabaseAdminClient();
  if (!runtime || !admin) redirect(pageUrl(org, { error: NOT_AVAILABLE }));
  const state = await loadBillingAccountState(admin, org, runtime.livemode);
  if (!state.available || !state.stripe?.enabled) redirect(pageUrl(org, { error: NOT_AVAILABLE }));
  return { userId: active.userId, runtime, admin, state };
}

/** Saves the billing details; the worker then pushes them to Stripe. */
export async function saveBillingDetails(formData: FormData): Promise<void> {
  const org = textField(formData.get('org'));
  const { userId, admin } = await requireBillingEditor(org);

  if (!(await checkRateLimit('billing-details-user', userId))) {
    redirect(
      pageUrl(org, {
        panel: 'details',
        error: 'Zu viele Änderungen. Bitte versuche es in ein paar Minuten erneut.',
      })
    );
  }

  const parsed = billingDetailsSchema.safeParse(billingDetailsFromForm(formData));
  if (!parsed.success) {
    redirect(pageUrl(org, { panel: 'details', error: billingDetailsErrorMessage(parsed.error) }));
  }

  const { error } = await saveBillingDetailsRow(admin, {
    orgId: org,
    details: parsed.data,
    userId,
  });
  if (error) {
    redirect(
      pageUrl(org, {
        panel: 'details',
        error: 'Die Rechnungsdaten konnten nicht gespeichert werden.',
      })
    );
  }

  revalidatePath('/settings/billing');
  redirect(pageUrl(org, { notice: 'Rechnungsdaten gespeichert.' }));
}

/**
 * Opens Stripe's page for storing a payment method (SEPA Direct Debit or card).
 * Zendori never sees an IBAN or a card number. Afterwards Stripe reports the
 * result through the webhook and the worker copies type + last four digits.
 */
export async function startPaymentSetup(formData: FormData): Promise<void> {
  const org = textField(formData.get('org'));
  const { userId, runtime, admin, state } = await requireBillingEditor(org);

  if (!(await checkRateLimit('billing-setup-user', userId))) {
    redirect(
      pageUrl(org, { error: 'Zu viele Versuche. Bitte versuche es in ein paar Minuten erneut.' })
    );
  }

  let target: string | null = null;
  try {
    const customerId = await ensureStripeCustomerId(admin, runtime.config, {
      orgId: org,
      livemode: runtime.livemode,
    });
    const base = appUrl().replace(/\/+$/, '');
    const session = await createSetupCheckoutSession(runtime.config, {
      customerId,
      orgId: org,
      // `was` = the method on file now: the page waits until it has changed, and
      // does not wait at all when the worker was faster than the redirect
      successUrl: `${base}${pageUrl(org, { payment: 'done', was: state.stripe?.paymentMethodId ?? 'none' })}`,
      cancelUrl: `${base}${pageUrl(org)}`,
    });
    target = session.url ?? null;
  } catch (error) {
    if (!(error instanceof StripeCustomerRowMissingError)) {
      // content-free: a code, never the request
      log.warn({ orgId: org, code: stripeErrorCode(error) }, 'payment setup could not be started');
    }
  }
  if (!target) {
    redirect(
      pageUrl(org, {
        error:
          'Die Seite des Zahlungsanbieters konnte nicht geöffnet werden. Bitte versuche es später erneut.',
      })
    );
  }
  redirect(target);
}

export interface BillingSyncState {
  /** The worker still has to bring Stripe up to date. */
  pending: boolean;
  paymentMethodId: string | null;
}

/** Polled by BillingSyncPoller. Any member who may see the billing page. */
export async function getBillingSyncState(orgId: string): Promise<BillingSyncState | null> {
  if (!z.uuid().safeParse(orgId).success) return null;
  const active = await requireActiveOrg(orgId);
  if (active.orgId !== orgId || !canViewArea(active.access, 'billing')) return null;
  const runtime = stripeRuntime();
  const admin = createSupabaseAdminClient();
  if (!runtime || !admin) return null;
  const state = await loadBillingAccountState(admin, orgId, runtime.livemode);
  if (!state.stripe) return null;
  return { pending: state.stripe.syncPending, paymentMethodId: state.stripe.paymentMethodId };
}
