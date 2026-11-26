import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAdminRole, type OrgRole } from '@zendori/core';
import { loadBillingAccountState } from '@/lib/billing-account';
import { stripeRuntime } from '@/lib/stripe';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/supabase/session';

// What the app shell asks to decide whether to show the "set up billing" banner
// (BillingSetupBanner). Signed-in members only (the middleware redirects
// everybody else); the answer is "nothing" unless the caller is owner or admin
// of the organization AND the operator switched it to Stripe billing in the
// current Stripe mode AND billing details or payment method are still missing.
//
// The billing tables are service-role only, so the shell cannot read them with
// the member's own session — this route reads them behind the membership check.
// It returns no billing data, only which of the two things is missing.

export const dynamic = 'force-dynamic';

export interface BillingSetupNotice {
  orgId: string;
  /** `details`: billing details are missing (a payment method may be missing too). */
  missing: 'details' | 'payment';
  livemode: boolean;
}

function answer(notice: BillingSetupNotice | null): NextResponse {
  return NextResponse.json({ notice }, { headers: { 'cache-control': 'no-store' } });
}

export async function GET(request: Request): Promise<NextResponse> {
  const requested = new URL(request.url).searchParams.get('org') ?? '';
  if (requested !== '' && !z.uuid().safeParse(requested).success) return answer(null);

  const runtime = stripeRuntime();
  if (!runtime) return answer(null);

  const user = await getSessionUser();
  if (!user) return answer(null);

  // the member's own rows (RLS); same pick as requireActiveOrg: the requested
  // organization if the user belongs to it, else the first one
  const supabase = await createSupabaseServerClient();
  const { data: memberData } = await supabase
    .from('org_members')
    .select('org_id, role')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });
  const memberships = (memberData ?? []) as { org_id: string; role: OrgRole }[];
  const membership = memberships.find((row) => row.org_id === requested) ?? memberships[0];
  if (!membership || !isAdminRole(membership.role)) return answer(null);

  const admin = createSupabaseAdminClient();
  if (!admin) return answer(null);
  const state = await loadBillingAccountState(admin, membership.org_id, runtime.livemode);
  if (!state.available || state.stripe?.enabled !== true) return answer(null);

  const missing =
    state.details === null ? 'details' : state.stripe.paymentMethodId === null ? 'payment' : null;
  if (missing === null) return answer(null);
  return answer({ orgId: membership.org_id, missing, livemode: runtime.livemode });
}
