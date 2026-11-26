import 'server-only';
import type { PackageChannelKind, SupabaseClient } from '@zendori/core';

// Keeps org_channel_limits (0017) in step with the terms that apply to a
// customer. The limits table is what the channel-creation trigger enforces; the
// terms (package + the customer's own values) are where the numbers come from.
// Service role only, behind requirePlatformAdmin.

/**
 * Writes the limits of one organization: a number becomes the limit of that
 * channel kind, null removes the row (= not limited). The kind 'test' is not
 * part of any package and is never touched.
 */
export async function syncChannelLimits(
  admin: SupabaseClient,
  orgId: string,
  plan: { kind: PackageChannelKind; maxCount: number | null }[]
): Promise<{ error: boolean }> {
  let failed = false;
  for (const { kind, maxCount } of plan) {
    const { error } =
      maxCount === null
        ? await admin
            .from('org_channel_limits')
            .delete()
            .eq('org_id', orgId)
            .eq('channel_kind', kind)
        : await admin
            .from('org_channel_limits')
            .upsert({ org_id: orgId, channel_kind: kind, max_count: maxCount });
    if (error) failed = true;
  }
  return { error: failed };
}
