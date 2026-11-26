// Preise & Pakete — the overview (platform admin). It has NO inputs: it shows
// which packages exist and what they cost, and what is charged per unit. A
// package and a price list are each edited on their own page; the three small
// forms (purchase costs, new package, new price list) open as drawers
// (?panel=costs | package | list). All reads/writes via the service role.
import Link from 'next/link';
import {
  PACKAGE_CHANNEL_KINDS,
  PACKAGE_CHANNEL_LABELS,
  countOwnValues,
  formatEuroInput,
  recurringMonthlyTotalEur,
  resolveTerms,
} from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import {
  formatEur,
  loadBillingCatalog,
  packageTermsOf,
  resolveOrgPriceList,
  type PackageRow,
} from '@/lib/billing';
import {
  belowCostCount,
  formatUnitEur,
  loadAvgTokenCosts,
  pricePositions,
  unpricedCount,
  type PricePosition,
} from '@/lib/billing-costs';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import DismissibleBanners from '@/components/DismissibleBanners';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { EmptyState, Section } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import AdminUnavailable from '../_components/AdminUnavailable';
import { createPackage, createPriceList, updatePurchaseCosts } from './actions';

const BASE = '/admin/pricing';

/** "Chat-Widget 1 · WhatsApp 2", and what is not limited. */
function channelSummary(pkg: PackageRow): string {
  const limited = PACKAGE_CHANNEL_KINDS.filter((kind) => pkg.channels[kind]);
  if (limited.length === 0) return 'Alle Kanäle unbegrenzt';
  const parts = limited.map((kind) => {
    const quota = pkg.channels[kind]?.quota ?? 0;
    return quota === 0
      ? `${PACKAGE_CHANNEL_LABELS[kind]} gesperrt`
      : `${PACKAGE_CHANNEL_LABELS[kind]} ${quota}`;
  });
  if (limited.length < PACKAGE_CHANNEL_KINDS.length) parts.push('übrige unbegrenzt');
  return parts.join(' · ');
}

/** What the customer is charged for a position, in words. */
function sellText(position: PricePosition): string {
  if (position.priceEur !== null) {
    return `${formatUnitEur(position.priceEur)} ${position.unitWords}`;
  }
  return position.hasCost ? 'Einkaufspreis wird weitergegeben' : 'wird nicht berechnet';
}

function MarginCell({ position }: { position: PricePosition }) {
  if (position.priceEur === null || position.costEur === null) {
    return <span className="muted">—</span>;
  }
  const margin = position.priceEur - position.costEur;
  if (margin < 0) return <Badge tone="danger">unter Einkauf</Badge>;
  return <>+{formatUnitEur(margin)}</>;
}

export default async function AdminPricingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; panel?: string }>;
}) {
  await requirePlatformAdmin();
  const { error, notice, panel } = await searchParams;

  const admin = createSupabaseAdminClient();
  if (!admin) return <AdminUnavailable title="Preise & Pakete" />;

  const catalog = await loadBillingCatalog(admin);
  const ctx = catalog.ctx;
  const avg = await loadAvgTokenCosts(admin, ctx.usdToEur);

  const lists = [...catalog.tiers.values()].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const packages = [...catalog.packages.values()].sort((a, b) => a.name.localeCompare(b.name));
  const subscriptions = [...catalog.subscriptions.values()];
  const defaultList = catalog.defaultTier;

  const packageRows = packages.map((pkg) => {
    const customers = subscriptions.filter((sub) => sub.packageId === pkg.id);
    return {
      pkg,
      monthlyEur: recurringMonthlyTotalEur(resolveTerms(packageTermsOf(pkg)), 'monthly'),
      listName:
        (pkg.priceTierId ? catalog.tiers.get(pkg.priceTierId)?.name : defaultList?.name) ?? '—',
      customers: customers.length,
      withOwnValues: customers.filter((sub) => countOwnValues(sub.own) > 0).length,
    };
  });

  const listRows = lists.map((list) => {
    const positions = pricePositions(list.pricing, ctx, avg);
    return {
      list,
      positions,
      packages: packages.filter((pkg) => (pkg.priceTierId ?? defaultList?.id) === list.id).length,
      customers: subscriptions.filter(
        (sub) => resolveOrgPriceList(catalog, sub.orgId)?.id === list.id
      ).length,
    };
  });
  const onlyList = listRows.length === 1 ? listRows[0] : undefined;

  // The three small forms live in drawers; their errors show inside.
  const drawer = panel === 'costs' || panel === 'package' || panel === 'list' ? panel : null;
  const costPositions = pricePositions({}, ctx, avg);

  return (
    <div className="page">
      <PageHeader
        title="Preise & Pakete"
        subtitle="Feste Gebühren stehen im Paket, Verbrauchspreise in der Preisliste."
        actions={
          <>
            <Button href={`${BASE}?panel=costs`} scroll={false}>
              Einkaufspreise
            </Button>
            <Button href={`${BASE}?panel=package`} variant="primary" icon="plus" scroll={false}>
              Neues Paket
            </Button>
          </>
        }
      />

      <div className="page-body">
        <DismissibleBanners error={drawer ? undefined : error} notice={notice} />

        <Section
          title="Pakete"
          help="Ein Paket legt Grundgebühr, Kanäle und die Preisliste fest. Abweichungen für einzelne Kunden trägst du beim Kunden ein."
        >
          {packageRows.length === 0 ? (
            <EmptyState
              title="Noch keine Pakete"
              text="Ein Paket bündelt Grundgebühr, Kanäle und eine Preisliste."
              action={
                <Button href={`${BASE}?panel=package`} icon="plus" scroll={false}>
                  Neues Paket
                </Button>
              }
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Paket</th>
                    <th>Status</th>
                    <th>Enthält</th>
                    <th className="num">Fest pro Monat</th>
                    <th>Preisliste</th>
                    <th>Kunden</th>
                  </tr>
                </thead>
                <tbody>
                  {packageRows.map(({ pkg, monthlyEur, listName, customers, withOwnValues }) => (
                    <tr key={pkg.id}>
                      <td>
                        <Link href={`${BASE}/packages/${pkg.id}`} className="cell-title">
                          {pkg.name}
                        </Link>
                      </td>
                      <td>
                        {pkg.isActive ? (
                          <Badge tone="success" dot>
                            Aktiv
                          </Badge>
                        ) : (
                          <Badge tone="muted" dot>
                            Inaktiv
                          </Badge>
                        )}
                      </td>
                      <td className="muted">{channelSummary(pkg)}</td>
                      <td className="num">
                        <span className="strong">{formatEur(monthlyEur)}</span>
                        {pkg.setupFeeEur > 0 || pkg.yearlyDiscountPercent > 0 ? (
                          <div className="cell-sub">
                            {[
                              pkg.setupFeeEur > 0
                                ? `Einrichtung ${formatEur(pkg.setupFeeEur)}`
                                : null,
                              pkg.yearlyDiscountPercent > 0
                                ? `Jahr −${formatEuroInput(pkg.yearlyDiscountPercent).replace(/,00$/, '')} %`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        ) : null}
                      </td>
                      <td className="muted">{listName}</td>
                      <td>
                        {customers}
                        {withOwnValues > 0 ? (
                          <span className="muted"> · {withOwnValues} mit eigenen Werten</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {onlyList ? (
          <Section
            title="Verbrauchspreise"
            help={
              <>
                Preisliste <strong>{onlyList.list.name}</strong>. Sie gilt für alle Pakete und
                Kunden.
              </>
            }
            actions={
              <>
                <Button href={`${BASE}?panel=list`} size="sm" icon="plus" scroll={false}>
                  Weitere Preisliste
                </Button>
                <Button href={`${BASE}/lists/${onlyList.list.id}`} size="sm">
                  Preise bearbeiten
                </Button>
              </>
            }
          >
            <div className="table-wrap">
              <table className="table--compact">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th className="num">Einkauf</th>
                    <th className="num">Verkauf</th>
                    <th className="num">Marge</th>
                  </tr>
                </thead>
                <tbody>
                  {onlyList.positions.map((position) => (
                    <tr key={position.category}>
                      <td>{position.label}</td>
                      <td className="num muted">{position.costLabel}</td>
                      <td className={position.priceEur === null ? 'num muted' : 'num'}>
                        {sellText(position)}
                      </td>
                      <td className="num">
                        <MarginCell position={position} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        ) : (
          <Section
            title="Preislisten"
            help="Verbrauchspreise je Position. Ein Paket nutzt die Standardliste, wenn du ihm keine andere gibst."
            actions={
              <Button href={`${BASE}?panel=list`} size="sm" icon="plus" scroll={false}>
                Weitere Preisliste
              </Button>
            }
          >
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Preisliste</th>
                    <th>Preise</th>
                    <th>Hinweise</th>
                    <th>Verwendet von</th>
                  </tr>
                </thead>
                <tbody>
                  {listRows.map(({ list, positions, packages: usedBy, customers }) => {
                    const below = belowCostCount(positions);
                    const unpriced = unpricedCount(positions);
                    return (
                      <tr key={list.id}>
                        <td>
                          <span className="row">
                            <Link href={`${BASE}/lists/${list.id}`} className="cell-title">
                              {list.name}
                            </Link>
                            {list.isDefault ? <Badge tone="success">Standard</Badge> : null}
                          </span>
                        </td>
                        <td className="muted">
                          {positions.length - unpriced} von {positions.length} bepreist
                        </td>
                        <td>
                          {below > 0 ? (
                            <Badge tone="danger">{below} unter Einkauf</Badge>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="muted">
                          {usedBy} {usedBy === 1 ? 'Paket' : 'Pakete'} · {customers}{' '}
                          {customers === 1 ? 'Kunde' : 'Kunden'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        )}
      </div>

      {drawer === 'costs' ? (
        <Drawer
          title="Einkaufspreise"
          closeHref={BASE}
          footer={
            <>
              <Button href={BASE} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="purchase-costs" variant="primary">
                Speichern
              </Button>
            </>
          }
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <p className="muted small">
            Was uns die Anbieter kosten. Die Rufnummern-Mieten trägst du selbst ein; bei den
            KI-Positionen ist es der Durchschnitt aus dem echten Verbrauch.
          </p>
          <form id="purchase-costs" action={updatePurchaseCosts}>
            <div className="table-wrap">
              <table className="table--compact">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th className="num">Einkauf</th>
                  </tr>
                </thead>
                <tbody>
                  {costPositions.map((position) => {
                    const editable =
                      position.category === 'numbers_mobile' ||
                      position.category === 'numbers_landline';
                    return (
                      <tr key={position.category}>
                        <td>
                          {position.label}
                          <div className="cell-sub">{position.unitWords}</div>
                        </td>
                        <td className="num">
                          {editable ? (
                            <span className="num-cell">
                              <input
                                name={
                                  position.category === 'numbers_mobile'
                                    ? 'numberCostMobileEur'
                                    : 'numberCostLandlineEur'
                                }
                                type="text"
                                inputMode="decimal"
                                required
                                aria-label={`Einkauf ${position.label}`}
                                className="num-input"
                                defaultValue={formatEuroInput(
                                  position.category === 'numbers_mobile'
                                    ? ctx.numberCostMobileEur
                                    : ctx.numberCostLandlineEur
                                )}
                              />
                              <span className="muted small">€</span>
                            </span>
                          ) : (
                            <span className="muted">{position.costLabel}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </form>
          <p className="field-help">
            Data Actions laufen im System des Kunden und haben deshalb keinen Einkaufspreis. Gezählt
            wird jede Aktion, die ein KI-Agent erfolgreich ausgeführt hat — auch nach Bestätigung
            durch einen Mitarbeiter und bei importierten MCP-Werkzeugen. Testläufe, fehlgeschlagene
            Aufrufe und verworfene Aktionen zählen nicht.
          </p>
        </Drawer>
      ) : null}

      {drawer === 'package' ? (
        <Drawer
          title="Neues Paket"
          closeHref={BASE}
          footer={
            <>
              <Button href={BASE} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="new-package" variant="primary">
                Paket anlegen
              </Button>
            </>
          }
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <form id="new-package" action={createPackage} className="stack">
            <Field label="Name" htmlFor="new-pkg-name">
              <input
                id="new-pkg-name"
                name="name"
                type="text"
                required
                minLength={2}
                maxLength={80}
                placeholder="z. B. Starter"
              />
            </Field>
            <Field
              label="Kopieren von"
              htmlFor="new-pkg-copy"
              help="Übernimmt Gebühren, Kanäle und Preisliste. Das neue Paket ist zuerst inaktiv, bis du es geprüft hast."
            >
              <select id="new-pkg-copy" name="copyFrom" defaultValue="">
                <option value="">— leer anfangen —</option>
                {packages.map((pkg) => (
                  <option key={pkg.id} value={pkg.id}>
                    {pkg.name}
                  </option>
                ))}
              </select>
            </Field>
          </form>
        </Drawer>
      ) : null}

      {drawer === 'list' ? (
        <Drawer
          title="Weitere Preisliste"
          closeHref={BASE}
          footer={
            <>
              <Button href={BASE} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="new-list" variant="primary">
                Preisliste anlegen
              </Button>
            </>
          }
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <form id="new-list" action={createPriceList} className="stack">
            <Field label="Name" htmlFor="new-list-name">
              <input
                id="new-list-name"
                name="name"
                type="text"
                required
                minLength={2}
                maxLength={80}
                placeholder="z. B. Partner"
              />
            </Field>
            <Field
              label="Preise kopieren von"
              htmlFor="new-list-copy"
              help="Eine neue Liste beginnt immer mit den Preisen einer bestehenden. So ist nie eine Position versehentlich ohne Preis."
            >
              <select id="new-list-copy" name="copyFrom" defaultValue={defaultList?.id ?? ''}>
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
            </Field>
          </form>
        </Drawer>
      ) : null}
    </div>
  );
}
