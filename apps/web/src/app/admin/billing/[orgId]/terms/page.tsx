// A customer's terms (platform admin): package, term and — only where they
// differ — the customer's own values, with what the customer pays calculated
// live. Replaces the former "Plan zuweisen" drawer. The form is the client
// component TermsEditor; this page loads the data and owns the page head with
// the one rare action (remove the assignment).
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { NO_OWN_TERMS, numberCostEur, type BillingCategory } from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { loadBillingCatalog, packageTermsOf } from '@/lib/billing';
import { loadAvgTokenCosts, pricePositions } from '@/lib/billing-costs';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import DismissibleBanners from '@/components/DismissibleBanners';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import AdminUnavailable from '../../../_components/AdminUnavailable';
import TermsEditor, {
  type TermsEditorList,
  type TermsEditorPackage,
} from '../../../_components/TermsEditor';
import { removeSubscription } from '../../actions';

export default async function AdminOrgTermsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  await requirePlatformAdmin();
  const { orgId } = await params;
  const { error, notice } = await searchParams;
  if (!z.uuid().safeParse(orgId).success) notFound();

  const admin = createSupabaseAdminClient();
  if (!admin) return <AdminUnavailable title="Abrechnung" />;

  const { data: orgRow } = await admin
    .from('organizations')
    .select('id, name')
    .eq('id', orgId)
    .maybeSingle();
  if (!orgRow) notFound();
  const org = orgRow as { id: string; name: string };

  const catalog = await loadBillingCatalog(admin);
  const avg = await loadAvgTokenCosts(admin, catalog.ctx.usdToEur);
  const sub = catalog.subscriptions.get(orgId);
  const own = sub?.own ?? NO_OWN_TERMS;

  // Active packages, plus the one this customer has even when it is inactive —
  // otherwise saving anything here would silently take the package away.
  const packages: TermsEditorPackage[] = [...catalog.packages.values()]
    .filter((pkg) => pkg.isActive || pkg.id === sub?.packageId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      isActive: pkg.isActive,
      priceTierId: pkg.priceTierId,
      terms: packageTermsOf(pkg),
    }));

  const lists: TermsEditorList[] = [...catalog.tiers.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((list) => {
      const prices: Partial<Record<BillingCategory, number>> = {};
      for (const [category, rule] of Object.entries(list.pricing)) {
        if (rule) prices[category as BillingCategory] = rule.unitPriceEur;
      }
      return { id: list.id, name: list.name, isDefault: list.isDefault, prices };
    });

  // purchase cost per position; the sell prices come from the lists above
  const positions = pricePositions({}, catalog.ctx, avg).map((position) => ({
    category: position.category,
    label: position.label,
    unitWords: position.unitWords,
    hasCost: position.hasCost,
    costEur: position.costEur,
    costLabel: position.costLabel,
  }));

  // phone numbers: what a number costs us, and how many this customer has active
  const numberCosts = {
    mobile: numberCostEur('mobile', catalog.ctx),
    landline: numberCostEur('landline', catalog.ctx),
  };
  const { data: numberData } = await admin
    .from('phone_numbers')
    .select('number_type')
    .eq('org_id', orgId)
    .eq('status', 'active');
  const numberCounts = { mobile: 0, landline: 0 };
  for (const row of (numberData ?? []) as { number_type: string }[]) {
    // same split as billing_org_rollup: 'local' and 'national' are landline
    if (row.number_type === 'mobile') numberCounts.mobile += 1;
    else numberCounts.landline += 1;
  }

  const customerHref = `/admin/billing/${org.id}`;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[
          { label: 'Abrechnung', href: '/admin/billing' },
          { label: org.name, href: customerHref },
          { label: 'Konditionen' },
        ]}
        title="Konditionen"
        subtitle={`Paket, Laufzeit und eigene Werte von ${org.name}.`}
        actions={
          sub ? (
            <Menu label={`Aktionen für die Konditionen von ${org.name}`}>
              <form action={removeSubscription}>
                <input type="hidden" name="orgId" value={org.id} />
                <p className="menu-note">
                  Entfernt Paket, Verbrauchspreisliste und alle eigenen Werte. Die
                  Kanal-Kontingente bleiben
                  bestehen.
                </p>
                <ConfirmDeleteButton
                  inMenu
                  label="Zuweisung entfernen"
                  confirmLabel="Endgültig entfernen"
                />
              </form>
            </Menu>
          ) : null
        }
      />
      <TermsEditor
        // remount with the stored values after a save
        key={JSON.stringify([sub?.packageId, sub?.interval, sub?.priceTierId, own])}
        orgId={org.id}
        packageId={sub?.packageId ?? null}
        interval={sub?.interval ?? 'monthly'}
        priceTierId={sub?.priceTierId ?? null}
        own={own}
        packages={packages}
        lists={lists}
        positions={positions}
        numberCosts={numberCosts}
        numberCounts={numberCounts}
        banners={<DismissibleBanners error={error} notice={notice} />}
      />
    </div>
  );
}
