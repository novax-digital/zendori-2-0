// One package (platform admin): fixed fees, channels and the price list on the
// left, what a customer pays — calculated live — on the right. The form itself
// is the client component PackageEditor; this page loads the data and owns the
// page head with the rare actions (copy, delete).
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PACKAGE_CHANNEL_KINDS, PACKAGE_CHANNEL_LABELS, countOwnValues } from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { loadBillingCatalog } from '@/lib/billing';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import DismissibleBanners from '@/components/DismissibleBanners';
import Badge from '@/components/ui/Badge';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import AdminUnavailable from '../../../_components/AdminUnavailable';
import PackageEditor from '../../_components/PackageEditor';
import { createPackage, deletePackage } from '../../actions';

export default async function AdminPackagePage({
  params,
  searchParams,
}: {
  params: Promise<{ packageId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  await requirePlatformAdmin();
  const { packageId } = await params;
  const { error, notice } = await searchParams;
  if (!z.uuid().safeParse(packageId).success) notFound();

  const admin = createSupabaseAdminClient();
  if (!admin) return <AdminUnavailable title="Preise & Pakete" />;

  const catalog = await loadBillingCatalog(admin);
  const pkg = catalog.packages.get(packageId);
  if (!pkg) notFound();

  const subscribers = [...catalog.subscriptions.values()].filter((sub) => sub.packageId === pkg.id);
  const { data: orgData } =
    subscribers.length > 0
      ? await admin
          .from('organizations')
          .select('id, name')
          .in(
            'id',
            subscribers.map((sub) => sub.orgId)
          )
      : { data: [] };
  const orgNames = new Map(
    ((orgData ?? []) as { id: string; name: string }[]).map((org) => [org.id, org.name])
  );
  const customers = subscribers
    .map((sub) => ({
      orgId: sub.orgId,
      name: orgNames.get(sub.orgId) ?? 'Organisation',
      ownValues: countOwnValues(sub.own),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const channels = PACKAGE_CHANNEL_KINDS.map((kind) => {
    const term = pkg.channels[kind];
    return {
      kind,
      label: PACKAGE_CHANNEL_LABELS[kind],
      quota: term ? term.quota : null,
      feeMonthlyEur: term?.feeMonthlyEur ?? 0,
    };
  });
  const lists = [...catalog.tiers.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((list) => ({ id: list.id, name: list.name, isDefault: list.isDefault }));

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: 'Preise & Pakete', href: '/admin/pricing' }, { label: pkg.name }]}
        title={pkg.name}
        badges={
          pkg.isActive ? (
            <Badge tone="success" dot>
              Aktiv
            </Badge>
          ) : (
            <Badge tone="muted" dot>
              Inaktiv
            </Badge>
          )
        }
        actions={
          <Menu label={`Aktionen für Paket ${pkg.name}`}>
            <form action={createPackage}>
              <input type="hidden" name="name" value={`${pkg.name} (Kopie)`.slice(0, 80)} />
              <input type="hidden" name="copyFrom" value={pkg.id} />
              <button className="menu-item" type="submit">
                <span className="menu-label">Kopie anlegen</span>
              </button>
            </form>
            <form action={deletePackage}>
              <input type="hidden" name="id" value={pkg.id} />
              {customers.length > 0 ? (
                <p className="menu-note">
                  Löschen ist erst möglich, wenn kein Kunde das Paket mehr nutzt.
                </p>
              ) : (
                <ConfirmDeleteButton
                  inMenu
                  label="Paket löschen"
                  confirmLabel="Endgültig löschen"
                />
              )}
            </form>
          </Menu>
        }
      />
      <PackageEditor
        // remount with the stored values after a save
        key={JSON.stringify([
          pkg.name,
          pkg.isActive,
          pkg.priceTierId,
          pkg.setupFeeEur,
          pkg.baseFeeMonthlyEur,
          pkg.yearlyDiscountPercent,
          channels,
        ])}
        id={pkg.id}
        name={pkg.name}
        isActive={pkg.isActive}
        priceTierId={pkg.priceTierId}
        setupFeeEur={pkg.setupFeeEur}
        baseFeeMonthlyEur={pkg.baseFeeMonthlyEur}
        yearlyDiscountPercent={pkg.yearlyDiscountPercent}
        channels={channels}
        lists={lists}
        customers={customers}
        banners={<DismissibleBanners error={error} notice={notice} />}
      />
    </div>
  );
}
