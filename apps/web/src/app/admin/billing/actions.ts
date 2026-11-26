'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  BILLING_CATEGORY_LABELS,
  BILLING_CATEGORY_ORDER,
  NUMBER_KINDS,
  NUMBER_KIND_LABELS,
  PACKAGE_CHANNEL_KINDS,
  PACKAGE_CHANNEL_LABELS,
  applicableOwnTerms,
  billingDetailsErrorMessage,
  billingDetailsSchema,
  channelLimitPlan,
  isMissingColumnError,
  isMissingRelationError,
  isPeriodKey,
  numberFeesSchema,
  parseBillingAccountRow,
  periodKeyOf,
  priceTierPricingSchema,
  readOwnTerms,
  resolveTerms,
  shiftPeriodKey,
  subscriptionOwnChannelsSchema,
  type BillingAccountRow,
  type BillingCategory,
  type NumberKind,
  type OwnTermsText,
  type PackageChannelKind,
  type PackageTerms,
  type SupabaseClient,
} from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { loadBillingCatalog, packageTermsOf } from '@/lib/billing';
import {
  billingDetailsFromForm,
  cancelBillingSync,
  requestBillingSync,
  saveBillingDetailsRow,
  setSetupMailRequest,
} from '@/lib/billing-account';
import { syncChannelLimits } from '@/lib/billing-terms';
import { stripeRuntime } from '@/lib/stripe';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function billingUrl(message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams();
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `/admin/billing?${qs}` : '/admin/billing';
}

// --- a customer's terms: package, interval, own values (Konditionen) ---------

type Message = { error?: string; notice?: string };

function withMessage(path: string, message?: Message): string {
  const params = new URLSearchParams();
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Abrechnung → Kunde → Konditionen: the page the terms form lives on. */
const termsUrl = (orgId: string, message?: Message): string =>
  withMessage(`/admin/billing/${orgId}/terms`, message);

const termsSchema = z.object({
  orgId: z.uuid(),
  packageId: z.union([z.uuid(), z.literal('')]),
  priceTierId: z.union([z.uuid(), z.literal('')]),
  interval: z.enum(['monthly', 'yearly']),
});

/** The form field a message from readOwnTerms belongs to, in words. */
function ownFieldLabel(field: string): string {
  if (field === 'setup') return 'Einrichtung';
  if (field === 'base') return 'Grundgebühr';
  if (field === 'discount') return 'Rabatt bei Jahreslaufzeit';
  const [group, key] = field.split(':') as [string, string | undefined];
  if (group === 'quota' && key) {
    return `${PACKAGE_CHANNEL_LABELS[key as PackageChannelKind] ?? key} (Anzahl)`;
  }
  if (group === 'fee' && key) {
    return `${PACKAGE_CHANNEL_LABELS[key as PackageChannelKind] ?? key} (je Kanal)`;
  }
  if (group === 'number' && key) return NUMBER_KIND_LABELS[key as NumberKind] ?? key;
  if (group === 'price' && key) return BILLING_CATEGORY_LABELS[key as BillingCategory] ?? key;
  return field;
}

/** One subscription per org (unique org_id): update, or insert when there is none yet. */
async function writeSubscription(
  admin: SupabaseClient,
  orgId: string,
  patch: Record<string, unknown>
): Promise<{ error: unknown }> {
  const { data: updated, error } = await admin
    .from('org_subscriptions')
    .update(patch)
    .eq('org_id', orgId)
    .select('id');
  if (error) return { error };
  if (updated && updated.length > 0) return { error: null };
  const { error: insertError } = await admin
    .from('org_subscriptions')
    .insert({ org_id: orgId, ...patch });
  return { error: insertError };
}

/**
 * Saves what applies to a customer: package, interval, price list and the
 * customer's own values (0042 — every empty field means "as in the package").
 * The text is read by readOwnTerms, the same function the form uses while
 * typing, so "1.500" is refused here too.
 *
 * Afterwards org_channel_limits (0017) is brought in line with the terms: the
 * package's numbers with the customer's own numbers on top, a kind that is not
 * limited loses its row. Without a package the limits are left as they are.
 */
export async function saveTerms(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const orgIdRaw = textField(formData.get('orgId'));
  if (!z.uuid().safeParse(orgIdRaw).success) {
    redirect(billingUrl({ error: 'Organisation wurde nicht gefunden.' }));
  }
  // annotated, so TypeScript knows a call never returns (narrowing below)
  const fail: (error: string) => never = (error) => redirect(termsUrl(orgIdRaw, { error }));

  const parsed = termsSchema.safeParse({
    orgId: orgIdRaw,
    packageId: textField(formData.get('packageId')),
    priceTierId: textField(formData.get('priceTierId')),
    interval: textField(formData.get('interval')),
  });
  if (!parsed.success) {
    return fail('Ungültige Angaben zu Paket, Laufzeit oder Verbrauchspreisliste.');
  }
  const { orgId, packageId, priceTierId, interval } = parsed.data;

  const channelText: OwnTermsText['channels'] = {};
  for (const kind of PACKAGE_CHANNEL_KINDS) {
    channelText[kind] = {
      quota: textField(formData.get(`own_quota_${kind}`)),
      feeMonthlyEur: textField(formData.get(`own_fee_${kind}`)),
    };
  }
  const numberText: OwnTermsText['numbers'] = {};
  for (const kind of NUMBER_KINDS) {
    numberText[kind] = textField(formData.get(`own_number_${kind}`));
  }
  const priceText: OwnTermsText['pricing'] = {};
  for (const category of BILLING_CATEGORY_ORDER) {
    priceText[category] = textField(formData.get(`own_price_${category}`));
  }
  const read = readOwnTerms({
    setupFeeEur: textField(formData.get('own_setup')),
    baseFeeMonthlyEur: textField(formData.get('own_base')),
    yearlyDiscountPercent: textField(formData.get('own_discount')),
    channels: channelText,
    numbers: numberText,
    pricing: priceText,
  });
  const firstError = Object.entries(read.errors)[0];
  if (firstError) fail(`${ownFieldLabel(firstError[0])}: ${firstError[1]}`);

  const admin = createSupabaseAdminClient();
  if (!admin) return fail('Service-Role ist serverseitig nicht konfiguriert.');

  const catalog = await loadBillingCatalog(admin);
  let packageTerms: PackageTerms | null = null;
  if (packageId !== '') {
    const pkg = catalog.packages.get(packageId);
    if (!pkg) return fail('Das Paket wurde nicht gefunden.');
    // an inactive package stays with the customers who have it, but is not handed out anew
    if (!pkg.isActive && catalog.subscriptions.get(orgId)?.packageId !== pkg.id) {
      fail('Dieses Paket ist inaktiv und kann nicht neu zugewiesen werden.');
    }
    packageTerms = packageTermsOf(pkg);
  }
  if (priceTierId !== '' && !catalog.tiers.has(priceTierId)) {
    fail('Die Verbrauchspreisliste wurde nicht gefunden.');
  }

  // only what can reach an invoice is stored (no fixed own values without a package)
  const own = applicableOwnTerms(read.own, packageTerms);
  const ownChannels = subscriptionOwnChannelsSchema.safeParse(own.channels);
  const ownPricing = priceTierPricingSchema.safeParse(own.pricing);
  const ownNumbers = numberFeesSchema.safeParse(own.numbers);
  if (!ownChannels.success || !ownPricing.success || !ownNumbers.success) {
    return fail('Ungültige eigene Werte.');
  }

  const patch = {
    package_id: packageId === '' ? null : packageId,
    price_tier_id: priceTierId === '' ? null : priceTierId,
    billing_interval: interval,
    setup_fee_eur: own.setupFeeEur,
    updated_at: new Date().toISOString(),
    updated_by: userId,
  };
  const ownColumns = {
    base_fee_monthly_eur: own.baseFeeMonthlyEur,
    yearly_discount_percent: own.yearlyDiscountPercent,
    channels: ownChannels.data,
    pricing: ownPricing.data,
  };
  let written = await writeSubscription(admin, orgId, {
    ...patch,
    ...ownColumns,
    numbers: ownNumbers.data,
  });
  if (written.error && isMissingColumnError(written.error)) {
    // 0043 not applied yet: everything but an own fee per phone number can be saved
    if (Object.keys(own.numbers).length > 0) {
      fail('Eigene Gebühren je Rufnummer sind noch nicht verfügbar (Migration 0043 ausstehend).');
    }
    written = await writeSubscription(admin, orgId, { ...patch, ...ownColumns });
  }
  if (written.error && isMissingColumnError(written.error)) {
    // 0042 not applied yet: package, interval, list and setup fee can be saved
    const needsMigration =
      own.baseFeeMonthlyEur !== null ||
      own.yearlyDiscountPercent !== null ||
      Object.keys(own.channels).length > 0 ||
      Object.keys(own.pricing).length > 0;
    if (needsMigration) {
      fail('Eigene Werte sind noch nicht verfügbar (Migration 0042 ausstehend).');
    }
    written = await writeSubscription(admin, orgId, patch);
  }
  if (written.error) fail('Die Konditionen konnten nicht gespeichert werden.');

  // Stale rows from an earlier package are replaced, so a change can never
  // leave a tighter leftover limit behind. 'test' is not a package kind.
  const limits = packageTerms
    ? await syncChannelLimits(admin, orgId, channelLimitPlan(resolveTerms(packageTerms, own)))
    : { error: false };

  revalidatePath(`/admin/billing/${orgId}`);
  revalidatePath(`/admin/billing/${orgId}/terms`);
  revalidatePath(`/admin/users/${orgId}`);
  revalidatePath('/admin/billing');
  revalidatePath('/admin/pricing');
  redirect(
    termsUrl(
      orgId,
      limits.error
        ? {
            error:
              'Konditionen gespeichert, aber die Kanal-Kontingente konnten nicht alle angepasst werden. Bitte erneut speichern.',
          }
        : {
            notice: packageTerms
              ? 'Konditionen gespeichert. Die Kanal-Kontingente sind angepasst.'
              : 'Konditionen gespeichert.',
          }
    )
  );
}

const removeSchema = z.object({ orgId: z.uuid() });

/**
 * Removes a customer's subscription: package, price list and every own value.
 * The quotas in org_channel_limits stay as they are.
 */
export async function removeSubscription(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const parsed = removeSchema.safeParse({ orgId: textField(formData.get('orgId')) });
  if (!parsed.success) redirect(billingUrl({ error: 'Organisation wurde nicht gefunden.' }));
  const { orgId } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(termsUrl(orgId, { error: 'Service-Role ist serverseitig nicht konfiguriert.' }));
  }

  const { error } = await admin.from('org_subscriptions').delete().eq('org_id', orgId);
  if (error) redirect(termsUrl(orgId, { error: 'Die Zuweisung konnte nicht entfernt werden.' }));

  revalidatePath(`/admin/billing/${orgId}`);
  revalidatePath(`/admin/billing/${orgId}/terms`);
  revalidatePath(`/admin/users/${orgId}`);
  revalidatePath('/admin/billing');
  revalidatePath('/admin/pricing');
  redirect(withMessage(`/admin/billing/${orgId}`, { notice: 'Paket-Zuweisung entfernt.' }));
}

// --- Stripe billing of a customer (Phase 15a) ---------------------------------

/** Abrechnung → Kunde; an error keeps the "Stripe-Abrechnung" drawer open. */
function stripeReturnUrl(orgId: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams();
  if (message?.error) {
    params.set('panel', 'stripe');
    params.set('error', message.error);
  }
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `/admin/billing/${orgId}?${qs}` : `/admin/billing/${orgId}`;
}

const STRIPE_NOT_CONFIGURED = 'Stripe ist nicht eingerichtet (STRIPE_SECRET_KEY fehlt).';
const STRIPE_NOT_MIGRATED = 'Die Stripe-Abrechnung ist noch nicht verfügbar (Migration 0041 ausstehend).';

/**
 * The first months an operator may pick: last, this and next month. An earlier
 * month that is already stored stays valid — past months are never back-billed
 * by accident through this form.
 */
function allowedInvoiceFrom(now: Date, stored: string | null): string[] {
  const current = periodKeyOf(now);
  const keys = [shiftPeriodKey(current, -1), current, shiftPeriodKey(current, 1)];
  if (stored && !keys.includes(stored)) keys.push(stored);
  return keys;
}

/**
 * Switches Stripe billing on or off for a customer IN THE CURRENT STRIPE MODE
 * (test / live — one row per mode, migration 0041), sets the first month and
 * optionally stores the billing details on the customer's behalf. Enabling asks
 * the worker to create and update the Stripe customer. With "Kunden per E-Mail
 * informieren" the worker then mails the owners and admins (0044); without it a
 * request that is still open is withdrawn.
 */
export async function saveStripeBilling(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const orgId = textField(formData.get('orgId'));
  if (!z.uuid().safeParse(orgId).success) {
    redirect(billingUrl({ error: 'Organisation wurde nicht gefunden.' }));
  }
  const runtime = stripeRuntime();
  if (!runtime) redirect(stripeReturnUrl(orgId, { error: STRIPE_NOT_CONFIGURED }));
  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(stripeReturnUrl(orgId, { error: 'Service-Role ist serverseitig nicht konfiguriert.' }));
  }

  const enabled = formData.get('enabled') === 'on';
  const invoiceFrom = textField(formData.get('invoiceFrom'));

  const { data: existing, error: readError } = await admin
    .from('billing_stripe_customers')
    .select('invoice_from')
    .eq('org_id', orgId)
    .eq('livemode', runtime.livemode)
    .maybeSingle();
  if (readError) {
    redirect(
      stripeReturnUrl(orgId, {
        error: isMissingRelationError(readError)
          ? STRIPE_NOT_MIGRATED
          : 'Die Einstellung konnte nicht gelesen werden.',
      })
    );
  }
  const storedFrom = (existing as { invoice_from: string | null } | null)?.invoice_from ?? null;
  if (!isPeriodKey(invoiceFrom) || !allowedInvoiceFrom(new Date(), storedFrom).includes(invoiceFrom)) {
    redirect(stripeReturnUrl(orgId, { error: 'Bitte wähle den ersten Abrechnungsmonat.' }));
  }

  // Billing details are optional here: an entirely empty block is left alone.
  const detailsInput = billingDetailsFromForm(formData);
  const hasDetails = Object.values(detailsInput).some((value) => value !== '');
  if (hasDetails) {
    const parsed = billingDetailsSchema.safeParse(detailsInput);
    if (!parsed.success) {
      redirect(stripeReturnUrl(orgId, { error: billingDetailsErrorMessage(parsed.error) }));
    }
    const saved = await saveBillingDetailsRow(admin, { orgId, details: parsed.data, userId });
    if (saved.error) {
      redirect(
        stripeReturnUrl(orgId, { error: 'Die Rechnungsdaten konnten nicht gespeichert werden.' })
      );
    }
  }

  const { error: upsertError } = await admin.from('billing_stripe_customers').upsert(
    {
      org_id: orgId,
      livemode: runtime.livemode,
      enabled,
      invoice_from: invoiceFrom,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    },
    { onConflict: 'org_id,livemode' }
  );
  if (upsertError) {
    redirect(stripeReturnUrl(orgId, { error: 'Die Einstellung konnte nicht gespeichert werden.' }));
  }
  // the mail request first: the sync job that follows is what sends it
  const notify = enabled && formData.get('notifyCustomer') === 'on';
  const mail = await setSetupMailRequest(admin, orgId, runtime.livemode, notify);
  if (enabled) {
    await requestBillingSync(admin, orgId);
  } else {
    // Switched off: a sync that is still open (the billing details saved above
    // may just have asked for one, or a retry is waiting) must not run any more.
    await cancelBillingSync(admin, orgId, runtime.livemode);
  }

  const mailNote = !notify
    ? ''
    : mail.unavailable
      ? ' Die E-Mail an den Kunden ist noch nicht verfügbar (Migration 0044 ausstehend).'
      : mail.error
        ? ' Die E-Mail an den Kunden konnte nicht vorgemerkt werden.'
        : ' Inhaber und Admins bekommen gleich eine E-Mail.';

  revalidatePath(`/admin/billing/${orgId}`);
  redirect(
    stripeReturnUrl(orgId, {
      notice: enabled
        ? `Stripe-Abrechnung aktiv${runtime.livemode ? '' : ' (Testmodus)'}.${mailNote}`
        : 'Stripe-Abrechnung ausgeschaltet.',
    })
  );
}

/**
 * The operator vouches for the customer's VAT id (Stripe's VIES check is
 * pending, unavailable or negative). The confirmation is stored with the VAT id
 * it was given for — a changed VAT id needs a new one.
 */
export async function confirmVatId(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const orgId = textField(formData.get('orgId'));
  if (!z.uuid().safeParse(orgId).success) {
    redirect(billingUrl({ error: 'Organisation wurde nicht gefunden.' }));
  }
  const back = (message: { error?: string; notice?: string }): string => {
    const params = new URLSearchParams(message as Record<string, string>);
    return `/admin/billing/${orgId}?${params.toString()}`;
  };
  const runtime = stripeRuntime();
  if (!runtime) redirect(back({ error: STRIPE_NOT_CONFIGURED }));
  const admin = createSupabaseAdminClient();
  if (!admin) redirect(back({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { data: accountRow } = await admin
    .from('billing_accounts')
    .select(
      'legal_name, address_line1, address_line2, postal_code, city, country, vat_id, billing_email'
    )
    .eq('org_id', orgId)
    .maybeSingle();
  const details = parseBillingAccountRow((accountRow as BillingAccountRow | null) ?? null);
  if (!details || details.vatId === '') {
    redirect(back({ error: 'Für diesen Kunden ist keine USt-ID hinterlegt.' }));
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error } = await admin
    .from('billing_stripe_customers')
    .update({
      vat_id_confirmed_value: details.vatId,
      vat_id_confirmed_by: userId,
      vat_id_confirmed_at: nowIso,
      updated_at: nowIso,
      updated_by: userId,
    })
    .eq('org_id', orgId)
    .eq('livemode', runtime.livemode)
    .select('org_id');
  if (error || !updated || updated.length === 0) {
    redirect(back({ error: 'Die Bestätigung konnte nicht gespeichert werden.' }));
  }

  revalidatePath(`/admin/billing/${orgId}`);
  redirect(back({ notice: 'USt-ID bestätigt.' }));
}
