// The customer's current plan as a side-rail block, with the button that opens
// the "Plan zuweisen" drawer (PlanDrawer). Used on Nutzer → Organisation and
// Abrechnung → Kunde.
import Button from '@/components/ui/Button';
import { Property, PropertyList } from '@/components/ui/Layout';
import { formatEur, type SubscriptionRow } from '@/lib/billing';

export default function PlanSummary({
  subscription,
  packageName,
  tierName,
  changeHref,
}: {
  subscription: SubscriptionRow | undefined;
  packageName: string | undefined;
  /** Name of the price-list override; undefined = taken from the plan. */
  tierName: string | undefined;
  /** The page with ?panel=plan. */
  changeHref: string;
}) {
  return (
    <div className="rail-section">
      <h2>Plan</h2>
      {subscription ? (
        <PropertyList>
          <Property label="Plan">{packageName ?? 'Kein Plan'}</Property>
          <Property label="Preisliste">{tierName ?? 'Aus dem Plan'}</Property>
          <Property label="Laufzeit">
            {subscription.interval === 'yearly' ? 'Jährlich' : 'Monatlich'}
          </Property>
          <Property label="Setup-Gebühr">
            {subscription.setupFeeEur != null ? formatEur(subscription.setupFeeEur) : 'Aus dem Plan'}
          </Property>
        </PropertyList>
      ) : (
        <p className="muted small">
          Kein Plan zugewiesen. Ohne Plan gelten keine Kontingent-Grenzen und nur der Verbrauch
          wird berechnet.
        </p>
      )}
      <div>
        <Button href={changeHref} size="sm" scroll={false}>
          {subscription ? 'Plan ändern' : 'Plan zuweisen'}
        </Button>
      </div>
    </div>
  );
}
