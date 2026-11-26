'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  BILLING_CATEGORY_LABELS,
  BILLING_CATEGORY_ORDER,
  NO_OWN_TERMS,
  NUMBER_KINDS,
  NUMBER_KIND_LABELS,
  PACKAGE_CHANNEL_KINDS,
  PACKAGE_CHANNEL_LABELS,
  channelLimitPlan,
  euroInputError,
  isMissingColumnError,
  numberFeesSchema,
  packageChannelsForStorage,
  packageChannelsSchema,
  priceTierPricingSchema,
  readEuro,
  resolveTerms,
  subscriptionOwnChannelsSchema,
  yearlyFromMonthlyEur,
  type CategoryPricingRule,
  type PackageTerms,
  type SupabaseClient,
} from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { syncChannelLimits } from '@/lib/billing-terms';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

// Preise & Pakete (platform admin). The overview has no inputs; a package and a
// price list are each edited on their own page, and the three small create /
// purchase-cost forms live in drawers on the overview (?panel=…). Every amount
// a person types goes through readEuro, so "1.500" is refused instead of being
// stored as 1,50 €.

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

type Message = { error?: string; notice?: string };

function withMessage(path: string, message?: Message, panel?: string): string {
  const params = new URLSearchParams();
  if (panel) params.set('panel', panel);
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** The overview; with `panel` an error keeps that drawer open. */
function pricingUrl(message?: Message, panel?: 'list' | 'package' | 'costs'): string {
  return withMessage('/admin/pricing', message, panel);
}
const packageUrl = (id: string, message?: Message): string =>
  withMessage(`/admin/pricing/packages/${id}`, message);
const listUrl = (id: string, message?: Message): string =>
  withMessage(`/admin/pricing/lists/${id}`, message);

const NO_SERVICE_ROLE = 'Service-Role ist serverseitig nicht konfiguriert.';
const NAME_ERROR = 'Der Name muss 2 bis 80 Zeichen lang sein.';
const validName = (name: string): boolean => name.length >= 2 && name.length <= 80;

const idSchema = z.uuid();
const optionalIdSchema = z.union([z.uuid(), z.literal('')]);

/** A typed amount: a number, or the message to show next to `label`. */
function amount(raw: string, label: string, max: number): { value: number } | { error: string } {
  const result = readEuro(raw);
  if (!result.ok) {
    return {
      error: `${label}: ${result.reason === 'empty' ? 'Bitte einen Betrag eingeben.' : euroInputError(result.reason)}`,
    };
  }
  if (result.value > max) return { error: `${label}: Der Betrag ist zu hoch.` };
  return { value: result.value };
}

// --- purchase costs (numbers) ------------------------------------------------

/** Save the editable monthly purchase costs per number type (billing_settings). */
export async function updatePurchaseCosts(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const mobile = amount(
    textField(formData.get('numberCostMobileEur')),
    NUMBER_KIND_LABELS.mobile,
    100_000
  );
  if ('error' in mobile) redirect(pricingUrl({ error: mobile.error }, 'costs'));
  const landline = amount(
    textField(formData.get('numberCostLandlineEur')),
    NUMBER_KIND_LABELS.landline,
    100_000
  );
  if ('error' in landline) redirect(pricingUrl({ error: landline.error }, 'costs'));

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(pricingUrl({ error: NO_SERVICE_ROLE }, 'costs'));

  const { error } = await admin
    .from('billing_settings')
    .update({
      number_cost_mobile_eur: mobile.value,
      number_cost_landline_eur: landline.value,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    })
    .is('org_id', null);
  if (error) {
    redirect(pricingUrl({ error: 'Einkaufspreise konnten nicht gespeichert werden.' }, 'costs'));
  }

  revalidatePath('/admin/pricing');
  redirect(pricingUrl({ notice: 'Einkaufspreise gespeichert.' }));
}

// --- usage price lists (Verbrauchspreislisten) --------------------------------

/**
 * A new price list always starts as a copy (of the chosen list, else of the
 * standard list): an empty list would bill every position at purchase cost the
 * moment it is assigned.
 */
export async function createPriceList(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const name = textField(formData.get('name'));
  if (!validName(name)) redirect(pricingUrl({ error: NAME_ERROR }, 'list'));
  const copyFrom = optionalIdSchema.safeParse(textField(formData.get('copyFrom')));
  if (!copyFrom.success)
    redirect(pricingUrl({ error: 'Die Vorlage wurde nicht gefunden.' }, 'list'));

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(pricingUrl({ error: NO_SERVICE_ROLE }, 'list'));

  const sourceQuery = admin.from('price_tiers').select('pricing');
  const { data: source } = await (
    copyFrom.data === '' ? sourceQuery.eq('is_default', true) : sourceQuery.eq('id', copyFrom.data)
  ).maybeSingle();
  const pricing = priceTierPricingSchema.safeParse(
    (source as { pricing?: unknown } | null)?.pricing ?? {}
  );

  const { data: created, error } = await admin
    .from('price_tiers')
    .insert({ name, pricing: pricing.success ? pricing.data : {}, updated_by: userId })
    .select('id')
    .single();
  if (error || !created) {
    redirect(pricingUrl({ error: 'Verbrauchspreisliste konnte nicht angelegt werden.' }, 'list'));
  }

  revalidatePath('/admin/pricing');
  redirect(
    listUrl((created as { id: string }).id, {
      notice: `Verbrauchspreisliste „${name}“ angelegt. Die Preise sind eine Kopie — passe sie hier an.`,
    })
  );
}

/** Save a price list: name + one free unit price per position (empty ⇒ purchase cost). */
export async function updatePriceList(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const parsedId = idSchema.safeParse(textField(formData.get('id')));
  if (!parsedId.success) {
    redirect(pricingUrl({ error: 'Verbrauchspreisliste wurde nicht gefunden.' }));
  }
  const id = parsedId.data;

  const name = textField(formData.get('name'));
  if (!validName(name)) redirect(listUrl(id, { error: NAME_ERROR }));

  const pricing: Record<string, CategoryPricingRule> = {};
  for (const category of BILLING_CATEGORY_ORDER) {
    const raw = textField(formData.get(`price_${category}`));
    if (raw === '') continue;
    const value = amount(raw, BILLING_CATEGORY_LABELS[category], 100_000);
    if ('error' in value) redirect(listUrl(id, { error: value.error }));
    pricing[category] = { mode: 'unit', unitPriceEur: value.value };
  }
  const validated = priceTierPricingSchema.safeParse(pricing);
  if (!validated.success) redirect(listUrl(id, { error: 'Ungültige Preisangaben.' }));

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(listUrl(id, { error: NO_SERVICE_ROLE }));

  const { error } = await admin
    .from('price_tiers')
    .update({
      name,
      pricing: validated.data,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    })
    .eq('id', id);
  if (error) {
    redirect(listUrl(id, { error: 'Verbrauchspreisliste konnte nicht gespeichert werden.' }));
  }

  revalidatePath('/admin/pricing');
  revalidatePath(`/admin/pricing/lists/${id}`);
  redirect(listUrl(id, { notice: 'Verbrauchspreisliste gespeichert.' }));
}

/**
 * A list can be deleted once no customer is billed by it — neither named on
 * the customer nor through the customer's package. Packages without such a
 * customer that still name the list fall back to the standard list (FK on
 * delete set null); the notice says which.
 */
export async function deletePriceList(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const parsedId = idSchema.safeParse(textField(formData.get('id')));
  if (!parsedId.success) {
    redirect(pricingUrl({ error: 'Verbrauchspreisliste wurde nicht gefunden.' }));
  }
  const id = parsedId.data;
  // where an error is shown: on the list's page, or in the overview it was sent from
  const fromOverview = formData.get('from') === 'overview';
  const fail = (error: string): string => (fromOverview ? pricingUrl({ error }) : listUrl(id, { error }));

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(fail(NO_SERVICE_ROLE));

  const [tierResult, packagesResult, directResult] = await Promise.all([
    admin.from('price_tiers').select('is_default').eq('id', id).maybeSingle(),
    admin.from('packages').select('id, name').eq('price_tier_id', id),
    admin
      .from('org_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('price_tier_id', id),
  ]);
  // a failed check is never read as "nobody uses it"
  if (tierResult.error || packagesResult.error || directResult.error) {
    redirect(fail('Verbrauchspreisliste konnte nicht geprüft werden.'));
  }
  if (!tierResult.data) redirect(pricingUrl({ error: 'Verbrauchspreisliste wurde nicht gefunden.' }));
  if ((tierResult.data as { is_default?: boolean }).is_default) {
    redirect(fail('Die Standardliste kann nicht gelöscht werden.'));
  }
  const usingPackages = (packagesResult.data ?? []) as { id: string; name: string }[];
  let customers = directResult.count ?? 0;
  if (usingPackages.length > 0) {
    // customers of these packages without a list of their own are billed by this one
    const viaPackage = await admin
      .from('org_subscriptions')
      .select('id', { count: 'exact', head: true })
      .in(
        'package_id',
        usingPackages.map((pkg) => pkg.id)
      )
      .is('price_tier_id', null);
    if (viaPackage.error) redirect(fail('Verbrauchspreisliste konnte nicht geprüft werden.'));
    customers += viaPackage.count ?? 0;
  }
  if (customers > 0) {
    redirect(
      fail(
        'Diese Verbrauchspreisliste wird noch von Kunden genutzt. Weise ihnen oder ihrem Paket zuerst eine andere zu.'
      )
    );
  }

  const { error } = await admin.from('price_tiers').delete().eq('id', id);
  if (error) redirect(fail('Verbrauchspreisliste konnte nicht gelöscht werden.'));

  revalidatePath('/admin/pricing');
  const names = usingPackages.map((pkg) => pkg.name).join(', ');
  redirect(
    pricingUrl({
      notice:
        usingPackages.length === 0
          ? 'Verbrauchspreisliste gelöscht.'
          : usingPackages.length === 1
            ? `Verbrauchspreisliste gelöscht. Das Paket ${names} nutzt jetzt die Standardliste.`
            : `Verbrauchspreisliste gelöscht. Diese Pakete nutzen jetzt die Standardliste: ${names}.`,
    })
  );
}

// --- packages ----------------------------------------------------------------

const PACKAGE_COPY_COLUMNS =
  'price_tier_id, setup_fee_eur, base_fee_monthly_eur, base_fee_yearly_eur, channels';

/**
 * A new package starts INACTIVE (it cannot be assigned before its fees are
 * checked) and, when asked, as a copy of an existing one.
 */
export async function createPackage(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const name = textField(formData.get('name'));
  if (!validName(name)) redirect(pricingUrl({ error: NAME_ERROR }, 'package'));
  const copyFrom = optionalIdSchema.safeParse(textField(formData.get('copyFrom')));
  if (!copyFrom.success)
    redirect(pricingUrl({ error: 'Die Vorlage wurde nicht gefunden.' }, 'package'));

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(pricingUrl({ error: NO_SERVICE_ROLE }, 'package'));

  let copied: Record<string, unknown> = {};
  if (copyFrom.data !== '') {
    // numbers is 0043, yearly_discount_percent 0042 — before a migration the
    // copy goes without the column it adds
    const columnSets = [
      `${PACKAGE_COPY_COLUMNS}, yearly_discount_percent, numbers`,
      `${PACKAGE_COPY_COLUMNS}, yearly_discount_percent`,
      PACKAGE_COPY_COLUMNS,
    ];
    let source: unknown = null;
    let sourceError: unknown = null;
    for (const columns of columnSets) {
      ({ data: source, error: sourceError } = await admin
        .from('packages')
        .select(columns)
        .eq('id', copyFrom.data)
        .maybeSingle());
      if (!(sourceError && isMissingColumnError(sourceError))) break;
    }
    if (sourceError || !source) {
      redirect(pricingUrl({ error: 'Die Vorlage wurde nicht gefunden.' }, 'package'));
    }
    copied = source as unknown as Record<string, unknown>;
  }

  const { data: created, error } = await admin
    .from('packages')
    .insert({ ...copied, name, is_active: false, updated_by: userId })
    .select('id')
    .single();
  if (error || !created) {
    redirect(pricingUrl({ error: 'Paket konnte nicht angelegt werden.' }, 'package'));
  }

  revalidatePath('/admin/pricing');
  redirect(
    packageUrl((created as { id: string }).id, {
      notice: `Paket „${name}“ angelegt. Es ist noch inaktiv — prüfe die Gebühren und schalte es dann aktiv.`,
    })
  );
}

/**
 * Brings the channel limits of every customer on this package in line with the
 * package (plus the customer's own values). Without this a raised quota would
 * be billed at once while the customer's limit stayed where it was.
 */
async function syncPackageCustomers(
  admin: SupabaseClient,
  packageId: string,
  terms: PackageTerms
): Promise<{ error: boolean }> {
  type Row = { org_id: string; channels?: unknown };
  const withOwn = await admin
    .from('org_subscriptions')
    .select('org_id, channels')
    .eq('package_id', packageId);
  let data = withOwn.data as Row[] | null;
  let error = withOwn.error;
  if (error && isMissingColumnError(error)) {
    // before 0042 no customer has own values
    const plain = await admin
      .from('org_subscriptions')
      .select('org_id')
      .eq('package_id', packageId);
    data = plain.data as Row[] | null;
    error = plain.error;
  }
  if (error) return { error: true };

  let failed = false;
  for (const row of data ?? []) {
    const own = subscriptionOwnChannelsSchema.safeParse(row.channels ?? {});
    const effective = resolveTerms(terms, {
      ...NO_OWN_TERMS,
      channels: own.success ? own.data : {},
    });
    const result = await syncChannelLimits(admin, row.org_id, channelLimitPlan(effective));
    if (result.error) failed = true;
  }
  return { error: failed };
}

/**
 * Save a package. Only monthly amounts are typed; the yearly values follow
 * from the discount and are written along for older readers.
 */
export async function updatePackage(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const parsedId = idSchema.safeParse(textField(formData.get('id')));
  if (!parsedId.success) redirect(pricingUrl({ error: 'Paket wurde nicht gefunden.' }));
  const id = parsedId.data;
  // annotated, so TypeScript knows a call never returns (narrowing below)
  const fail: (error: string) => never = (error) => redirect(packageUrl(id, { error }));

  const name = textField(formData.get('name'));
  if (!validName(name)) fail(NAME_ERROR);
  const priceTierId = optionalIdSchema.safeParse(textField(formData.get('priceTierId')));
  if (!priceTierId.success) fail('Die Verbrauchspreisliste wurde nicht gefunden.');

  // An empty fee field means 0 €; an empty quota means "not limited".
  const money = (field: string, label: string): number => {
    const raw = textField(formData.get(field));
    if (raw === '') return 0;
    const value = amount(raw, label, 1_000_000);
    return 'error' in value ? fail(value.error) : value.value;
  };
  const setupFeeEur = money('setupFeeEur', 'Einrichtung');
  const baseFeeMonthlyEur = money('baseFeeMonthlyEur', 'Grundgebühr');
  const discountRaw = textField(formData.get('yearlyDiscountPercent'));
  const discount = discountRaw === '' ? { ok: true as const, value: 0 } : readEuro(discountRaw);
  if (!discount.ok || discount.value > 100) {
    fail('Rabatt bei Jahreslaufzeit: Bitte eine Zahl zwischen 0 und 100 eingeben.');
  }
  const yearlyDiscountPercent = discount.ok ? discount.value : 0;

  const terms: PackageTerms = {
    setupFeeEur,
    baseFeeMonthlyEur,
    yearlyDiscountPercent,
    channels: {},
    numbers: {},
  };
  // Fee per phone number: an empty field is NOT 0 € — it passes our purchase
  // cost on, so a number is never given away by leaving a field blank.
  for (const kind of NUMBER_KINDS) {
    const raw = textField(formData.get(`number_fee_${kind}`));
    if (raw === '') continue;
    const value = amount(raw, NUMBER_KIND_LABELS[kind], 100_000);
    if ('error' in value) fail(value.error);
    else terms.numbers[kind] = { feeMonthlyEur: value.value };
  }
  const numbers = numberFeesSchema.safeParse(terms.numbers);
  if (!numbers.success) fail('Ungültige Angaben zu den Rufnummern.');
  for (const kind of PACKAGE_CHANNEL_KINDS) {
    const label = PACKAGE_CHANNEL_LABELS[kind];
    const quotaRaw = textField(formData.get(`quota_${kind}`));
    if (quotaRaw === '') continue; // not limited, no fee
    if (!/^\d{1,4}$/.test(quotaRaw)) {
      fail(`${label}: Die Anzahl muss eine ganze Zahl von 0 bis 9999 sein (leer = unbegrenzt).`);
    }
    terms.channels[kind] = {
      quota: Number(quotaRaw),
      feeMonthlyEur: money(`fee_${kind}`, label),
    };
  }
  const channels = packageChannelsSchema.safeParse(
    packageChannelsForStorage(terms.channels, yearlyDiscountPercent)
  );
  if (!channels.success) fail('Ungültige Kanal-Angaben.');

  const admin = createSupabaseAdminClient();
  if (!admin) return fail(NO_SERVICE_ROLE);

  const patch = {
    name,
    price_tier_id: priceTierId.data === '' ? null : priceTierId.data,
    setup_fee_eur: setupFeeEur,
    base_fee_monthly_eur: baseFeeMonthlyEur,
    base_fee_yearly_eur: yearlyFromMonthlyEur(baseFeeMonthlyEur, yearlyDiscountPercent),
    channels: channels.data,
    is_active: textField(formData.get('isActive')) === 'on',
    updated_at: new Date().toISOString(),
    updated_by: userId,
  };
  let { error } = await admin
    .from('packages')
    .update({ ...patch, yearly_discount_percent: yearlyDiscountPercent, numbers: numbers.data })
    .eq('id', id);
  if (error && isMissingColumnError(error)) {
    // 0043 not applied yet: everything but the fee per phone number can be saved
    if (Object.keys(terms.numbers).length > 0) {
      fail('Gebühren je Rufnummer sind noch nicht verfügbar (Migration 0043 ausstehend).');
    }
    ({ error } = await admin
      .from('packages')
      .update({ ...patch, yearly_discount_percent: yearlyDiscountPercent })
      .eq('id', id));
  }
  if (error && isMissingColumnError(error)) {
    // 0042 not applied yet: everything but the discount can be saved
    if (yearlyDiscountPercent !== 0) {
      fail('Der Rabatt bei Jahreslaufzeit ist noch nicht verfügbar (Migration 0042 ausstehend).');
    }
    ({ error } = await admin.from('packages').update(patch).eq('id', id));
  }
  if (error) fail('Paket konnte nicht gespeichert werden.');

  const synced = await syncPackageCustomers(admin, id, terms);

  revalidatePath('/admin/pricing');
  revalidatePath(`/admin/pricing/packages/${id}`);
  redirect(
    packageUrl(
      id,
      synced.error
        ? {
            error:
              'Paket gespeichert, aber die Kanal-Kontingente der Kunden konnten nicht alle angepasst werden. Bitte erneut speichern.',
          }
        : { notice: 'Paket gespeichert.' }
    )
  );
}

/**
 * Deleting a package that customers use would silently remove all their fixed
 * fees (FK on delete set null) — refused instead.
 */
export async function deletePackage(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const parsedId = idSchema.safeParse(textField(formData.get('id')));
  if (!parsedId.success) redirect(pricingUrl({ error: 'Paket wurde nicht gefunden.' }));
  const id = parsedId.data;
  // where an error is shown: on the package's page, or in the overview it was sent from
  const fromOverview = formData.get('from') === 'overview';
  const fail = (error: string): string =>
    fromOverview ? pricingUrl({ error }) : packageUrl(id, { error });

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(fail(NO_SERVICE_ROLE));

  const { count, error: countError } = await admin
    .from('org_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('package_id', id);
  // a failed check is never read as "nobody uses it"
  if (countError) redirect(fail('Paket konnte nicht geprüft werden.'));
  if ((count ?? 0) > 0) {
    redirect(
      fail(
        'Dieses Paket wird noch von Kunden genutzt. Weise ihnen zuerst ein anderes Paket zu oder schalte es nur inaktiv.'
      )
    );
  }

  const { error } = await admin.from('packages').delete().eq('id', id);
  if (error) redirect(fail('Paket konnte nicht gelöscht werden.'));

  revalidatePath('/admin/pricing');
  redirect(pricingUrl({ notice: 'Paket gelöscht.' }));
}
