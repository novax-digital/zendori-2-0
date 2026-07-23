'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { PACKAGE_CHANNEL_KINDS } from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Parse a German- or English-formatted decimal ("1,25" or "1.25"). */
function parseDecimal(value: string): number {
  return Number(value.replace(',', '.'));
}

function billingUrl(message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams();
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `/admin/billing?${qs}` : '/admin/billing';
}

function orgBillingUrl(orgId: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams();
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `/admin/billing/${orgId}?${qs}` : `/admin/billing/${orgId}`;
}

// --- global defaults: FX + target margin -------------------------------------

const globalSchema = z.object({
  targetMargin: z.number().min(0).max(1000),
  usdToEur: z.number().gt(0).max(100),
});

/** Update the global FX + target margin (the seed billing_settings row). */
export async function updateGlobalPricing(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const parsed = globalSchema.safeParse({
    targetMargin: parseDecimal(textField(formData.get('targetMargin'))),
    usdToEur: parseDecimal(textField(formData.get('usdToEur'))),
  });
  if (!parsed.success) {
    redirect(billingUrl({ error: 'Ziel-Marge (≥ 0) und Wechselkurs (> 0) müssen gültige Zahlen sein.' }));
  }

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(billingUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { error } = await admin
    .from('billing_settings')
    .update({
      target_margin: parsed.data.targetMargin,
      usd_to_eur: parsed.data.usdToEur,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    })
    .is('org_id', null);
  if (error) redirect(billingUrl({ error: 'Einstellungen konnten nicht gespeichert werden.' }));

  revalidatePath('/admin/billing');
  redirect(billingUrl({ notice: 'Globale Einstellungen gespeichert.' }));
}

// --- assign a package/tier to a customer -------------------------------------

const assignSchema = z.object({
  orgId: z.uuid(),
  packageId: z.union([z.uuid(), z.literal('')]),
  priceTierId: z.union([z.uuid(), z.literal('')]),
  interval: z.enum(['monthly', 'yearly']),
  setupFeeEur: z.union([z.number().min(0).max(1_000_000), z.nan()]),
});

/**
 * Assign (or update) a customer's package, tier override and interval, and push
 * the package's channel quotas into org_channel_limits (0017) so the existing
 * enforcement applies. One subscription per org (unique org_id → update-or-insert).
 */
export async function assignPackage(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const orgIdRaw = textField(formData.get('orgId'));
  const setupRaw = textField(formData.get('setupFeeEur'));
  const parsed = assignSchema.safeParse({
    orgId: orgIdRaw,
    packageId: textField(formData.get('packageId')),
    priceTierId: textField(formData.get('priceTierId')),
    interval: textField(formData.get('interval')),
    setupFeeEur: setupRaw === '' ? Number.NaN : parseDecimal(setupRaw),
  });
  if (!parsed.success) {
    redirect(orgBillingUrl(orgIdRaw, { error: 'Ungültige Paket-/Tarif-Angaben.' }));
  }
  const { orgId, packageId, priceTierId, interval, setupFeeEur } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(orgBillingUrl(orgId, { error: 'Service-Role ist serverseitig nicht konfiguriert.' }));
  }

  const patch = {
    package_id: packageId === '' ? null : packageId,
    price_tier_id: priceTierId === '' ? null : priceTierId,
    billing_interval: interval,
    setup_fee_eur: Number.isNaN(setupFeeEur) ? null : setupFeeEur,
    updated_at: new Date().toISOString(),
    updated_by: userId,
  };
  const { data: updated, error: updateError } = await admin
    .from('org_subscriptions')
    .update(patch)
    .eq('org_id', orgId)
    .select('id');
  if (updateError) {
    redirect(orgBillingUrl(orgId, { error: 'Zuweisung konnte nicht gespeichert werden.' }));
  }
  if (!updated || updated.length === 0) {
    const { error: insertError } = await admin
      .from('org_subscriptions')
      .insert({ org_id: orgId, ...patch });
    if (insertError) {
      redirect(orgBillingUrl(orgId, { error: 'Zuweisung konnte nicht angelegt werden.' }));
    }
  }

  // Push the package's channel quotas into org_channel_limits (unlimited stays
  // untouched only where the package has no term for that kind).
  if (packageId !== '') {
    const { data: pkgRow } = await admin
      .from('packages')
      .select('channels')
      .eq('id', packageId)
      .maybeSingle();
    const channels = (pkgRow as { channels?: Record<string, { quota?: number }> } | null)?.channels ?? {};
    for (const kind of PACKAGE_CHANNEL_KINDS) {
      const term = channels[kind];
      if (!term || typeof term.quota !== 'number') continue;
      await admin
        .from('org_channel_limits')
        .upsert({ org_id: orgId, channel_kind: kind, max_count: term.quota });
    }
  }

  revalidatePath(`/admin/billing/${orgId}`);
  redirect(orgBillingUrl(orgId, { notice: 'Paket zugewiesen. Kanal-Kontingente aktualisiert.' }));
}

const removeSchema = z.object({ orgId: z.uuid() });

/** Remove a customer's subscription (quotas in org_channel_limits stay as-is). */
export async function removeSubscription(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const parsed = removeSchema.safeParse({ orgId: textField(formData.get('orgId')) });
  if (!parsed.success) redirect(billingUrl({ error: 'Organisation wurde nicht gefunden.' }));
  const { orgId } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(orgBillingUrl(orgId, { error: 'Service-Role ist serverseitig nicht konfiguriert.' }));
  }

  const { error } = await admin.from('org_subscriptions').delete().eq('org_id', orgId);
  if (error) redirect(orgBillingUrl(orgId, { error: 'Zuweisung konnte nicht entfernt werden.' }));

  revalidatePath(`/admin/billing/${orgId}`);
  redirect(orgBillingUrl(orgId, { notice: 'Paket-Zuweisung entfernt.' }));
}
