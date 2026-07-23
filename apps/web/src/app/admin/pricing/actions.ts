'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  MARKUP_PRICED_CATEGORIES,
  PACKAGE_CHANNEL_KINDS,
  UNIT_PRICED_CATEGORIES,
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

function tiersUrl(message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams();
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `/admin/pricing/tiers?${qs}` : '/admin/pricing/tiers';
}

function packagesUrl(message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams();
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `/admin/pricing/packages?${qs}` : '/admin/pricing/packages';
}

// --- price tiers -------------------------------------------------------------

export async function createTier(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const name = textField(formData.get('name'));
  if (name.length < 2 || name.length > 80) {
    redirect(tiersUrl({ error: 'Name muss 2–80 Zeichen lang sein.' }));
  }

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(tiersUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { error } = await admin.from('price_tiers').insert({ name, updated_by: userId });
  if (error) redirect(tiersUrl({ error: 'Preisstaffel konnte nicht angelegt werden.' }));

  revalidatePath('/admin/pricing/tiers');
  redirect(tiersUrl({ notice: `Preisstaffel „${name}" angelegt.` }));
}

const tierIdSchema = z.object({ id: z.uuid() });

/** Save a tier's name and per-category overrides (empty field ⇒ recommendation). */
export async function updateTier(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const parsed = tierIdSchema.safeParse({ id: textField(formData.get('id')) });
  if (!parsed.success) redirect(tiersUrl({ error: 'Preisstaffel wurde nicht gefunden.' }));
  const { id } = parsed.data;

  const name = textField(formData.get('name'));
  if (name.length < 2 || name.length > 80) {
    redirect(tiersUrl({ error: 'Name muss 2–80 Zeichen lang sein.' }));
  }

  const pricing: Record<string, CategoryPricingRule> = {};
  for (const category of UNIT_PRICED_CATEGORIES) {
    const raw = textField(formData.get(`price_${category}`));
    if (raw === '') continue;
    const value = parseDecimal(raw);
    if (Number.isFinite(value) && value >= 0) pricing[category] = { mode: 'unit', unitPriceEur: value };
  }
  for (const category of MARKUP_PRICED_CATEGORIES) {
    const raw = textField(formData.get(`markup_${category}`));
    if (raw === '') continue;
    const value = parseDecimal(raw);
    if (Number.isFinite(value) && value >= 0) pricing[category] = { mode: 'markup', factor: value };
  }
  const validated = priceTierPricingSchema.safeParse(pricing);
  if (!validated.success) redirect(tiersUrl({ error: 'Ungültige Preisangaben.' }));

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(tiersUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { error } = await admin
    .from('price_tiers')
    .update({ name, pricing: validated.data, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('id', id);
  if (error) redirect(tiersUrl({ error: 'Preisstaffel konnte nicht gespeichert werden.' }));

  revalidatePath('/admin/pricing/tiers');
  redirect(tiersUrl({ notice: 'Preisstaffel gespeichert.' }));
}

export async function deleteTier(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const parsed = tierIdSchema.safeParse({ id: textField(formData.get('id')) });
  if (!parsed.success) redirect(tiersUrl({ error: 'Preisstaffel wurde nicht gefunden.' }));
  const { id } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(tiersUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { data: tier } = await admin
    .from('price_tiers')
    .select('is_default')
    .eq('id', id)
    .maybeSingle();
  if ((tier as { is_default?: boolean } | null)?.is_default) {
    redirect(tiersUrl({ error: 'Die Standard-Staffel kann nicht gelöscht werden.' }));
  }

  const { error } = await admin.from('price_tiers').delete().eq('id', id);
  if (error) redirect(tiersUrl({ error: 'Preisstaffel konnte nicht gelöscht werden.' }));

  revalidatePath('/admin/pricing/tiers');
  redirect(tiersUrl({ notice: 'Preisstaffel gelöscht.' }));
}

// --- packages ----------------------------------------------------------------

export async function createPackage(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const name = textField(formData.get('name'));
  if (name.length < 2 || name.length > 80) {
    redirect(packagesUrl({ error: 'Name muss 2–80 Zeichen lang sein.' }));
  }

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(packagesUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { error } = await admin.from('packages').insert({ name, updated_by: userId });
  if (error) redirect(packagesUrl({ error: 'Paket konnte nicht angelegt werden.' }));

  revalidatePath('/admin/pricing/packages');
  redirect(packagesUrl({ notice: `Paket „${name}" angelegt.` }));
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
  if (!parsed.success) redirect(packagesUrl({ error: 'Ungültige Paket-Angaben.' }));

  const name = textField(formData.get('name'));
  if (name.length < 2 || name.length > 80) {
    redirect(packagesUrl({ error: 'Name muss 2–80 Zeichen lang sein.' }));
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
  if (!validatedChannels.success) redirect(packagesUrl({ error: 'Ungültige Kanal-Angaben.' }));

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(packagesUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

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
  if (error) redirect(packagesUrl({ error: 'Paket konnte nicht gespeichert werden.' }));

  revalidatePath('/admin/pricing/packages');
  redirect(packagesUrl({ notice: 'Paket gespeichert.' }));
}

const packageIdSchema = z.object({ id: z.uuid() });

export async function deletePackage(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const parsed = packageIdSchema.safeParse({ id: textField(formData.get('id')) });
  if (!parsed.success) redirect(packagesUrl({ error: 'Paket wurde nicht gefunden.' }));

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(packagesUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { error } = await admin.from('packages').delete().eq('id', parsed.data.id);
  if (error) redirect(packagesUrl({ error: 'Paket konnte nicht gelöscht werden.' }));

  revalidatePath('/admin/pricing/packages');
  redirect(packagesUrl({ notice: 'Paket gelöscht.' }));
}
