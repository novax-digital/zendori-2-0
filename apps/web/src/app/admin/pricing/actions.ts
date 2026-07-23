'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  BILLING_CATEGORY_ORDER,
  PACKAGE_CHANNEL_KINDS,
  packageChannelsSchema,
  priceTierPricingSchema,
  type CategoryPricingRule,
  type PackageChannelTerm,
} from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseDecimal(value: string): number {
  return Number(value.replace(',', '.'));
}

function pricingUrl(message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams();
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `/admin/pricing?${qs}` : '/admin/pricing';
}

// --- purchase costs (numbers) ------------------------------------------------

const purchaseSchema = z.object({
  numberCostMobileEur: z.number().min(0).max(100_000),
  numberCostLandlineEur: z.number().min(0).max(100_000),
});

/** Save the editable monthly purchase costs per number type (billing_settings). */
export async function updatePurchaseCosts(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const parsed = purchaseSchema.safeParse({
    numberCostMobileEur: parseDecimal(textField(formData.get('numberCostMobileEur')) || '0'),
    numberCostLandlineEur: parseDecimal(textField(formData.get('numberCostLandlineEur')) || '0'),
  });
  if (!parsed.success) {
    redirect(pricingUrl({ error: 'Nummern-Einkaufspreise müssen Zahlen ≥ 0 sein.' }));
  }

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(pricingUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { error } = await admin
    .from('billing_settings')
    .update({
      number_cost_mobile_eur: parsed.data.numberCostMobileEur,
      number_cost_landline_eur: parsed.data.numberCostLandlineEur,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    })
    .is('org_id', null);
  if (error) redirect(pricingUrl({ error: 'Einkaufspreise konnten nicht gespeichert werden.' }));

  revalidatePath('/admin/pricing');
  redirect(pricingUrl({ notice: 'Einkaufspreise gespeichert.' }));
}

// --- price lists (Preislisten) ----------------------------------------------

export async function createPriceList(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const name = textField(formData.get('name'));
  if (name.length < 2 || name.length > 80) {
    redirect(pricingUrl({ error: 'Name muss 2–80 Zeichen lang sein.' }));
  }

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(pricingUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { error } = await admin.from('price_tiers').insert({ name, updated_by: userId });
  if (error) redirect(pricingUrl({ error: 'Preisliste konnte nicht angelegt werden.' }));

  revalidatePath('/admin/pricing');
  redirect(pricingUrl({ notice: `Preisliste „${name}" angelegt.` }));
}

const idSchema = z.object({ id: z.uuid() });

/** Save a price list: name + one free unit price per position (empty ⇒ Selbstkosten). */
export async function updatePriceList(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const parsed = idSchema.safeParse({ id: textField(formData.get('id')) });
  if (!parsed.success) redirect(pricingUrl({ error: 'Preisliste wurde nicht gefunden.' }));
  const { id } = parsed.data;

  const name = textField(formData.get('name'));
  if (name.length < 2 || name.length > 80) {
    redirect(pricingUrl({ error: 'Name muss 2–80 Zeichen lang sein.' }));
  }

  const pricing: Record<string, CategoryPricingRule> = {};
  for (const category of BILLING_CATEGORY_ORDER) {
    const raw = textField(formData.get(`price_${category}`));
    if (raw === '') continue;
    const value = parseDecimal(raw);
    if (!Number.isFinite(value) || value < 0) {
      redirect(pricingUrl({ error: 'Preise müssen Zahlen ≥ 0 sein (leer = Selbstkosten).' }));
    }
    pricing[category] = { mode: 'unit', unitPriceEur: value };
  }
  const validated = priceTierPricingSchema.safeParse(pricing);
  if (!validated.success) redirect(pricingUrl({ error: 'Ungültige Preisangaben.' }));

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(pricingUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { error } = await admin
    .from('price_tiers')
    .update({ name, pricing: validated.data, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('id', id);
  if (error) redirect(pricingUrl({ error: 'Preisliste konnte nicht gespeichert werden.' }));

  revalidatePath('/admin/pricing');
  redirect(pricingUrl({ notice: 'Preisliste gespeichert.' }));
}

export async function deletePriceList(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const parsed = idSchema.safeParse({ id: textField(formData.get('id')) });
  if (!parsed.success) redirect(pricingUrl({ error: 'Preisliste wurde nicht gefunden.' }));
  const { id } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(pricingUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { data: tier } = await admin
    .from('price_tiers')
    .select('is_default')
    .eq('id', id)
    .maybeSingle();
  if ((tier as { is_default?: boolean } | null)?.is_default) {
    redirect(pricingUrl({ error: 'Die Standard-Preisliste kann nicht gelöscht werden.' }));
  }

  const { error } = await admin.from('price_tiers').delete().eq('id', id);
  if (error) redirect(pricingUrl({ error: 'Preisliste konnte nicht gelöscht werden.' }));

  revalidatePath('/admin/pricing');
  redirect(pricingUrl({ notice: 'Preisliste gelöscht.' }));
}

// --- packages ----------------------------------------------------------------

export async function createPackage(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const name = textField(formData.get('name'));
  if (name.length < 2 || name.length > 80) {
    redirect(pricingUrl({ error: 'Name muss 2–80 Zeichen lang sein.' }));
  }

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(pricingUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { error } = await admin.from('packages').insert({ name, updated_by: userId });
  if (error) redirect(pricingUrl({ error: 'Paket konnte nicht angelegt werden.' }));

  revalidatePath('/admin/pricing');
  redirect(pricingUrl({ notice: `Paket „${name}" angelegt.` }));
}

const packageSchema = z.object({
  id: z.uuid(),
  priceTierId: z.union([z.uuid(), z.literal('')]),
  setupFeeEur: z.number().min(0).max(1_000_000),
  baseFeeMonthlyEur: z.number().min(0).max(1_000_000),
  baseFeeYearlyEur: z.number().min(0).max(1_000_000),
  isActive: z.boolean(),
});

export async function updatePackage(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const parsed = packageSchema.safeParse({
    id: textField(formData.get('id')),
    priceTierId: textField(formData.get('priceTierId')),
    setupFeeEur: parseDecimal(textField(formData.get('setupFeeEur')) || '0'),
    baseFeeMonthlyEur: parseDecimal(textField(formData.get('baseFeeMonthlyEur')) || '0'),
    baseFeeYearlyEur: parseDecimal(textField(formData.get('baseFeeYearlyEur')) || '0'),
    isActive: textField(formData.get('isActive')) === 'on',
  });
  if (!parsed.success) redirect(pricingUrl({ error: 'Ungültige Paket-Angaben.' }));

  const name = textField(formData.get('name'));
  if (name.length < 2 || name.length > 80) {
    redirect(pricingUrl({ error: 'Name muss 2–80 Zeichen lang sein.' }));
  }

  const channels: Record<string, PackageChannelTerm> = {};
  for (const kind of PACKAGE_CHANNEL_KINDS) {
    const q = textField(formData.get(`quota_${kind}`));
    const fm = textField(formData.get(`feem_${kind}`));
    const fy = textField(formData.get(`feey_${kind}`));
    if (q === '' && fm === '' && fy === '') continue;
    channels[kind] = {
      quota: q === '' ? 0 : Math.trunc(Number(q)),
      feeMonthlyEur: fm === '' ? 0 : parseDecimal(fm),
      feeYearlyEur: fy === '' ? 0 : parseDecimal(fy),
    };
  }
  const validatedChannels = packageChannelsSchema.safeParse(channels);
  if (!validatedChannels.success) redirect(pricingUrl({ error: 'Ungültige Kanal-Angaben.' }));

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(pricingUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { error } = await admin
    .from('packages')
    .update({
      name,
      price_tier_id: parsed.data.priceTierId === '' ? null : parsed.data.priceTierId,
      setup_fee_eur: parsed.data.setupFeeEur,
      base_fee_monthly_eur: parsed.data.baseFeeMonthlyEur,
      base_fee_yearly_eur: parsed.data.baseFeeYearlyEur,
      channels: validatedChannels.data,
      is_active: parsed.data.isActive,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    })
    .eq('id', parsed.data.id);
  if (error) redirect(pricingUrl({ error: 'Paket konnte nicht gespeichert werden.' }));

  revalidatePath('/admin/pricing');
  redirect(pricingUrl({ notice: 'Paket gespeichert.' }));
}

export async function deletePackage(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const parsed = idSchema.safeParse({ id: textField(formData.get('id')) });
  if (!parsed.success) redirect(pricingUrl({ error: 'Paket wurde nicht gefunden.' }));

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(pricingUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { error } = await admin.from('packages').delete().eq('id', parsed.data.id);
  if (error) redirect(pricingUrl({ error: 'Paket konnte nicht gelöscht werden.' }));

  revalidatePath('/admin/pricing');
  redirect(pricingUrl({ notice: 'Paket gelöscht.' }));
}
