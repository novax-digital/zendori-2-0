import 'server-only';
import {
  NUMBER_KINDS,
  PACKAGE_CHANNEL_KINDS,
  channelMonthlyFeeEur,
  numberCostEur,
  type ChannelKind,
  type NumberKind,
  type PackageChannelKind,
} from '@zendori/core';
import { loadBillingCatalog, resolveOrgTerms } from '@/lib/billing';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

// What an ACTIVE channel costs an organization per month (migration 0045): the
// fee per channel from the customer's terms (package + own values), with the
// yearly discount applied. The channel pages show it before a channel is
// created or activated, so nobody starts a monthly fee without being told.
//
// The pricing tables are service-role only. Callers are the channel pages and
// actions, which have verified the membership (requireActiveOrg / RLS on the
// channel they touch) — only the organization's own fee per kind leaves here.

/** Fee per active channel and month in EUR, per kind; only kinds that cost something. */
export type ChannelFees = Partial<Record<PackageChannelKind, number>>;

export async function loadChannelFees(orgId: string): Promise<ChannelFees> {
  const admin = createSupabaseAdminClient();
  if (!admin) return {};
  const catalog = await loadBillingCatalog(admin);
  const terms = resolveOrgTerms(catalog, orgId);
  const interval = catalog.subscriptions.get(orgId)?.interval ?? 'monthly';
  if (!terms) return {};
  const fees: ChannelFees = {};
  for (const kind of PACKAGE_CHANNEL_KINDS) {
    const fee = channelMonthlyFeeEur(terms, interval, kind);
    if (fee > 0) fees[kind] = fee;
  }
  return fees;
}

/**
 * What this organization pays per phone number and month, per kind (0043): its
 * own fee, else the package's; where neither prices a kind — or without a
 * package — the purchase cost is passed on, and that is then the customer's price.
 */
export async function loadNumberFees(orgId: string): Promise<Record<NumberKind, number>> {
  const fees: Record<NumberKind, number> = { mobile: 0, landline: 0 };
  const admin = createSupabaseAdminClient();
  if (!admin) return fees;
  const catalog = await loadBillingCatalog(admin);
  const terms = resolveOrgTerms(catalog, orgId);
  for (const kind of NUMBER_KINDS) {
    const fee = terms?.numbers.find((number) => number.kind === kind)?.feeMonthlyEur ?? null;
    fees[kind] = fee ?? numberCostEur(kind, catalog.ctx);
  }
  return fees;
}

/** The fee of one kind out of loadChannelFees; 0 = free (also for the kind `test`). */
export function channelFeeOf(fees: ChannelFees, kind: ChannelKind): number {
  return kind === 'test' ? 0 : (fees[kind] ?? 0);
}

/** "15,00 €" */
export function formatChannelFee(feeEur: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(feeEur);
}
