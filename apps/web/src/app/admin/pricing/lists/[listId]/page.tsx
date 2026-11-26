// One usage price list (platform admin): a sell price per position with our purchase
// cost and the live margin next to it. The form is the client component
// PriceListEditor; this page loads the data and owns the page head with the
// rare actions (copy, delete).
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { loadBillingCatalog, resolveOrgPriceList } from '@/lib/billing';
import { loadAvgTokenCosts, pricePositions } from '@/lib/billing-costs';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import DismissibleBanners from '@/components/DismissibleBanners';
import Badge from '@/components/ui/Badge';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import AdminUnavailable from '../../../_components/AdminUnavailable';
import PriceListEditor from '../../_components/PriceListEditor';
import { createPriceList, deletePriceList } from '../../actions';

export default async function AdminPriceListPage({
  params,
  searchParams,
}: {
  params: Promise<{ listId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  await requirePlatformAdmin();
  const { listId } = await params;
  const { error, notice } = await searchParams;
  if (!z.uuid().safeParse(listId).success) notFound();

  const admin = createSupabaseAdminClient();
  if (!admin) return <AdminUnavailable title="Preise & Pakete" />;

  const catalog = await loadBillingCatalog(admin);
  const list = catalog.tiers.get(listId);
  if (!list) notFound();
  const avg = await loadAvgTokenCosts(admin, catalog.ctx.usdToEur);

  const positions = pricePositions(list.pricing, catalog.ctx, avg).map((position) => ({
    category: position.category,
    label: position.label,
    unitWords: position.unitWords,
    hasCost: position.hasCost,
    costEur: position.costEur,
    costLabel: position.costLabel,
    priceEur: position.priceEur,
  }));
  const packages = [...catalog.packages.values()]
    .filter((pkg) => (pkg.priceTierId ?? catalog.defaultTier?.id) === list.id)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((pkg) => ({ id: pkg.id, name: pkg.name }));
  const subscriptions = [...catalog.subscriptions.values()];
  const customerCount = subscriptions.filter(
    (sub) => resolveOrgPriceList(catalog, sub.orgId)?.id === list.id
  ).length;
  // a list named directly on a package or a customer cannot be deleted
  const pinned =
    [...catalog.packages.values()].some((pkg) => pkg.priceTierId === list.id) ||
    subscriptions.some((sub) => sub.priceTierId === list.id);

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: 'Preise & Pakete', href: '/admin/pricing' }, { label: list.name }]}
        title={list.name}
        badges={list.isDefault ? <Badge tone="success">Standard</Badge> : null}
        actions={
          <Menu label={`Aktionen für Verbrauchspreisliste ${list.name}`}>
            <form action={createPriceList}>
              <input type="hidden" name="name" value={`${list.name} (Kopie)`.slice(0, 80)} />
              <input type="hidden" name="copyFrom" value={list.id} />
              <button className="menu-item" type="submit">
                <span className="menu-label">Kopie anlegen</span>
              </button>
            </form>
            <form action={deletePriceList}>
              <input type="hidden" name="id" value={list.id} />
              {list.isDefault ? (
                <p className="menu-note">Die Standardliste kann nicht gelöscht werden.</p>
              ) : pinned ? (
                <p className="menu-note">
                  Löschen ist erst möglich, wenn kein Paket und kein Kunde die Liste mehr nutzt.
                </p>
              ) : (
                <ConfirmDeleteButton
                  inMenu
                  label="Verbrauchspreisliste löschen"
                  confirmLabel="Endgültig löschen"
                />
              )}
            </form>
          </Menu>
        }
      />
      <PriceListEditor
        // remount with the stored values after a save
        key={JSON.stringify([list.name, positions.map((position) => position.priceEur)])}
        id={list.id}
        name={list.name}
        isDefault={list.isDefault}
        positions={positions}
        packages={packages}
        customerCount={customerCount}
        banners={<DismissibleBanners error={error} notice={notice} />}
      />
    </div>
  );
}
