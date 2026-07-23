'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
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

const pricingSchema = z.object({
  markupFactor: z.number().min(0).max(1000),
  usdToEur: z.number().gt(0).max(100),
});

/** Update the global default markup + FX (the seed row with org_id null). */
export async function updateGlobalPricing(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const parsed = pricingSchema.safeParse({
    markupFactor: parseDecimal(textField(formData.get('markupFactor'))),
    usdToEur: parseDecimal(textField(formData.get('usdToEur'))),
  });
  if (!parsed.success) {
    redirect(billingUrl({ error: 'Aufschlag (≥ 0) und Wechselkurs (> 0) müssen gültige Zahlen sein.' }));
  }

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(billingUrl({ error: 'Service-Role ist serverseitig nicht konfiguriert.' }));

  const { error } = await admin
    .from('billing_settings')
    .update({
      markup_factor: parsed.data.markupFactor,
      usd_to_eur: parsed.data.usdToEur,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    })
    .is('org_id', null);
  if (error) redirect(billingUrl({ error: 'Einstellungen konnten nicht gespeichert werden.' }));

  revalidatePath('/admin/billing');
  redirect(billingUrl({ notice: 'Globale Preis-Einstellungen gespeichert.' }));
}

const orgPricingSchema = pricingSchema.extend({ orgId: z.uuid() });

/**
 * Set a per-org markup/FX override (update-or-insert; the partial unique index
 * keeps at most one row per org). Overrides the global default for that org.
 */
export async function updateOrgPricing(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();

  const orgIdRaw = textField(formData.get('orgId'));
  const parsed = orgPricingSchema.safeParse({
    orgId: orgIdRaw,
    markupFactor: parseDecimal(textField(formData.get('markupFactor'))),
    usdToEur: parseDecimal(textField(formData.get('usdToEur'))),
  });
  if (!parsed.success) {
    redirect(
      orgBillingUrl(orgIdRaw, {
        error: 'Aufschlag (≥ 0) und Wechselkurs (> 0) müssen gültige Zahlen sein.',
      })
    );
  }
  const { orgId, markupFactor, usdToEur } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(orgBillingUrl(orgId, { error: 'Service-Role ist serverseitig nicht konfiguriert.' }));
  }

  const patch = {
    markup_factor: markupFactor,
    usd_to_eur: usdToEur,
    updated_at: new Date().toISOString(),
    updated_by: userId,
  };
  const { data: updated, error: updateError } = await admin
    .from('billing_settings')
    .update(patch)
    .eq('org_id', orgId)
    .select('id');
  if (updateError) {
    redirect(orgBillingUrl(orgId, { error: 'Override konnte nicht gespeichert werden.' }));
  }
  if (!updated || updated.length === 0) {
    const { error: insertError } = await admin
      .from('billing_settings')
      .insert({ org_id: orgId, ...patch });
    if (insertError) {
      redirect(orgBillingUrl(orgId, { error: 'Override konnte nicht angelegt werden.' }));
    }
  }

  revalidatePath(`/admin/billing/${orgId}`);
  redirect(orgBillingUrl(orgId, { notice: 'Individueller Preis für diesen Kunden gespeichert.' }));
}

const resetSchema = z.object({ orgId: z.uuid() });

/** Remove a per-org override so the org falls back to the global default. */
export async function resetOrgPricing(formData: FormData): Promise<void> {
  await requirePlatformAdmin();

  const parsed = resetSchema.safeParse({ orgId: textField(formData.get('orgId')) });
  if (!parsed.success) redirect(billingUrl({ error: 'Organisation wurde nicht gefunden.' }));
  const { orgId } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(orgBillingUrl(orgId, { error: 'Service-Role ist serverseitig nicht konfiguriert.' }));
  }

  const { error } = await admin.from('billing_settings').delete().eq('org_id', orgId);
  if (error) redirect(orgBillingUrl(orgId, { error: 'Override konnte nicht entfernt werden.' }));

  revalidatePath(`/admin/billing/${orgId}`);
  redirect(orgBillingUrl(orgId, { notice: 'Individueller Preis entfernt — globaler Standard gilt.' }));
}
