// What applies to a customer, as a side-rail block: package, term, the fixed
// monthly amount and how many values differ from the package — with the link
// to the page where all of it is edited (Abrechnung → Kunde → Konditionen).
// Used on Nutzer → Organisation and Abrechnung → Kunde.
import { applicableOwnTerms, countOwnValues, recurringMonthlyTotalEur } from '@zendori/core';
import Button from '@/components/ui/Button';
import { Property, PropertyList } from '@/components/ui/Layout';
import {
  formatEur,
  packageTermsOf,
  resolveOrgPriceList,
  resolveOrgTerms,
  type BillingCatalog,
} from '@/lib/billing';

export default function TermsSummary({
  catalog,
  orgId,
}: {
  catalog: BillingCatalog;
  orgId: string;
}) {
  const sub = catalog.subscriptions.get(orgId);
  const pkg = sub?.packageId ? catalog.packages.get(sub.packageId) : undefined;
  const terms = resolveOrgTerms(catalog, orgId);
  const list = resolveOrgPriceList(catalog, orgId);
  // only values that can reach an invoice count (none of the fixed ones without a package)
  const ownValues = sub
    ? countOwnValues(applicableOwnTerms(sub.own, pkg ? packageTermsOf(pkg) : null))
    : 0;

  return (
    <div className="rail-section">
      <h2>Konditionen</h2>
      {sub ? (
        <PropertyList>
          <Property label="Paket">
            {pkg ? (pkg.isActive ? pkg.name : `${pkg.name} (inaktiv)`) : 'Kein Paket'}
          </Property>
          <Property label="Laufzeit">
            {sub.interval === 'yearly' ? 'Jährlich' : 'Monatlich'}
          </Property>
          {terms ? (
            <Property label="Fest pro Monat">
              <strong>{formatEur(recurringMonthlyTotalEur(terms, sub.interval))}</strong>
            </Property>
          ) : null}
          <Property label="Eigene Werte">{ownValues === 0 ? 'keine' : ownValues}</Property>
          <Property label="Verbrauchspreise">
            {list ? list.name : 'Einkaufspreise'}
            {sub.priceTierId ? ' (eigene)' : ''}
          </Property>
        </PropertyList>
      ) : (
        <p className="muted small">Kein Paket zugewiesen. Berechnet wird nur der Verbrauch.</p>
      )}
      <div>
        <Button href={`/admin/billing/${orgId}/terms`} size="sm">
          {sub ? 'Konditionen bearbeiten' : 'Paket zuweisen'}
        </Button>
      </div>
    </div>
  );
}
