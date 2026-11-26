import { NextResponse } from 'next/server';
import { z } from 'zod';
import { canViewArea, parseMemberPermissions, type OrgRole } from '@zendori/core';
import { invoicePdfUrl, loadInvoice } from '@/lib/invoices';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/supabase/session';

// The PDF of an invoice (Phase 15b). The file lives in a private bucket; this
// route checks who is asking and answers with a redirect to a link that works
// for one minute. Allowed: a platform admin, and a member of the invoice's
// organization who may see the billing area. Everybody else gets 404 — the
// same answer as for an invoice that does not exist.

export const dynamic = 'force-dynamic';

const notFound = (): NextResponse => new NextResponse('Nicht gefunden', { status: 404 });

export async function GET(
  _request: Request,
  context: { params: Promise<{ invoiceId: string }> }
): Promise<NextResponse> {
  const { invoiceId } = await context.params;
  if (!z.uuid().safeParse(invoiceId).success) return notFound();

  const user = await getSessionUser();
  if (!user) return notFound();
  const admin = createSupabaseAdminClient();
  if (!admin) return notFound();
  const invoice = await loadInvoice(admin, invoiceId);
  if (!invoice) return notFound();

  // the caller's own rows (RLS): platform admin, or member of the organization
  const supabase = await createSupabaseServerClient();
  const { data: adminRow } = await supabase
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  let allowed = Boolean(adminRow);
  if (!allowed && invoice.orgId) {
    const { data: member } = await supabase
      .from('org_members')
      .select('role, permissions')
      .eq('org_id', invoice.orgId)
      .eq('user_id', user.id)
      .maybeSingle();
    const row = member as { role: OrgRole; permissions: unknown } | null;
    allowed =
      row !== null &&
      canViewArea({ role: row.role, permissions: parseMemberPermissions(row.permissions) }, 'billing');
  }
  if (!allowed) return notFound();

  const url = await invoicePdfUrl(admin, invoice);
  if (!url) return new NextResponse('Das PDF wird noch erzeugt.', { status: 409 });
  return NextResponse.redirect(url, { status: 302, headers: { 'cache-control': 'no-store' } });
}
