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

/**
 * The assign/remove forms live on TWO admin pages since the unification
 * (Organisationen-Detailseite + Abrechnungs-Detailseite). `returnTo=org` sends
 * the redirect back to where the form was submitted; the value is a fixed enum,
 * never a path from the client.
 */
function subscriptionReturnUrl(
  formData: FormData,
  orgId: string,
  message?: { error?: string; notice?: string }
): string {
  if (textField(formData.get('returnTo')) === 'org') {
    const params = new URLSearchParams();
    if (message?.error) params.set('error', message.error);
    if (message?.notice) params.set('notice', message.notice);
    const qs = params.toString();
    return qs ? `/admin/users/${orgId}?${qs}` : `/admin/users/${orgId}`;
  }
  return orgBillingUrl(orgId, message);
}

// --- assign a package/price list to a customer -------------------------------

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
    redirect(subscriptionReturnUrl(formData, orgIdRaw, { error: 'Ungültige Paket-/Tarif-Angaben.' }));
  }
  const { orgId, packageId, priceTierId, interval, setupFeeEur } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(
      subscriptionReturnUrl(formData, orgId, {
        error: 'Service-Role ist serverseitig nicht konfiguriert.',
      })
    );
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
    redirect(
      subscriptionReturnUrl(formData, orgId, { error: 'Zuweisung konnte nicht gespeichert werden.' })
    );
  }
  if (!updated || updated.length === 0) {
    const { error: insertError } = await admin
      .from('org_subscriptions')
      .insert({ org_id: orgId, ...patch });
    if (insertError) {
      redirect(
        subscriptionReturnUrl(formData, orgId, { error: 'Zuweisung konnte nicht angelegt werden.' })
      );
    }
  }

  // The plan is THE source of channel quotas (unification 2026-07-27; the
  // manual per-org quota editor is gone): a kind the package prices gets the
  // package's quota, a kind the package does not mention becomes unlimited —
  // stale rows from an earlier plan or the old manual editor are deleted, so
  // switching plans can never leave a tighter leftover limit behind. 'test' is
  // not a package kind and stays untouched. The 0017 trigger keeps enforcing
  // whatever ends up in org_channel_limits.
  if (packageId !== '') {
    const { data: pkgRow } = await admin
      .from('packages')
      .select('channels')
      .eq('id', packageId)
      .maybeSingle();
    const channels = (pkgRow as { channels?: Record<string, { quota?: number }> } | null)?.channels ?? {};
    for (const kind of PACKAGE_CHANNEL_KINDS) {
      const term = channels[kind];
      if (term && typeof term.quota === 'number') {
        await admin
          .from('org_channel_limits')
          .upsert({ org_id: orgId, channel_kind: kind, max_count: term.quota });
      } else {
        await admin
          .from('org_channel_limits')
          .delete()
          .eq('org_id', orgId)
          .eq('channel_kind', kind);
      }
    }
  }

  revalidatePath(`/admin/billing/${orgId}`);
  revalidatePath(`/admin/users/${orgId}`);
  redirect(
    subscriptionReturnUrl(formData, orgId, {
      notice: 'Plan zugewiesen. Kanal-Kontingente aus dem Plan übernommen.',
    })
  );
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
    redirect(
      subscriptionReturnUrl(formData, orgId, {
        error: 'Service-Role ist serverseitig nicht konfiguriert.',
      })
    );
  }

  const { error } = await admin.from('org_subscriptions').delete().eq('org_id', orgId);
  if (error) {
    redirect(
      subscriptionReturnUrl(formData, orgId, { error: 'Zuweisung konnte nicht entfernt werden.' })
    );
  }

  revalidatePath(`/admin/billing/${orgId}`);
  revalidatePath(`/admin/users/${orgId}`);
  redirect(subscriptionReturnUrl(formData, orgId, { notice: 'Plan-Zuweisung entfernt.' }));
}
