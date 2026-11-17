// "Plan zuweisen" — the one form that assigns a package, price list and
// interval to a customer. It is opened from two pages (Nutzer → Organisation
// and Abrechnung → Kunde) with ?panel=plan; `returnTo` tells the shared
// actions in billing/actions.ts which of the two to redirect back to.
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import type { SubscriptionRow } from '@/lib/billing';
import { assignPackage, removeSubscription } from '../billing/actions';

interface Choice {
  id: string;
  name: string;
}

export default function PlanDrawer({
  orgId,
  closeHref,
  returnTo,
  subscription,
  packages,
  tiers,
  error,
}: {
  orgId: string;
  /** The page without the panel parameter. */
  closeHref: string;
  /** 'org' = opened from Nutzer → Organisation; omitted = Abrechnung → Kunde. */
  returnTo?: 'org';
  subscription: SubscriptionRow | undefined;
  /** Active packages, sorted. */
  packages: Choice[];
  /** Price lists, sorted. */
  tiers: Choice[];
  /** Error of the last submit (the actions redirect back with panel=plan). */
  error?: string;
}) {
  return (
    <Drawer
      title="Plan zuweisen"
      closeHref={closeHref}
      footer={
        <>
          <Button href={closeHref} scroll={false}>
            Abbrechen
          </Button>
          <Button type="submit" form="plan-assign" variant="primary">
            {subscription?.packageId ? 'Plan aktualisieren' : 'Plan zuweisen'}
          </Button>
        </>
      }
    >
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <form id="plan-assign" action={assignPackage} className="stack">
        <input type="hidden" name="orgId" value={orgId} />
        {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
        <Field
          label="Plan"
          htmlFor="packageId"
          help="Bestimmt Paketgebühren und Kanal-Kontingente. Kanalarten ohne Eintrag im Plan sind unbegrenzt."
        >
          <select id="packageId" name="packageId" defaultValue={subscription?.packageId ?? ''}>
            <option value="">— kein Plan —</option>
            {packages.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Preisliste"
          htmlFor="priceTierId"
          help="Bestimmt die Verbrauchspreise. Optional eine andere Liste für bessere Konditionen."
        >
          <select id="priceTierId" name="priceTierId" defaultValue={subscription?.priceTierId ?? ''}>
            <option value="">— aus Plan übernehmen —</option>
            {tiers.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Laufzeit" htmlFor="interval">
          <select id="interval" name="interval" defaultValue={subscription?.interval ?? 'monthly'}>
            <option value="monthly">Monatlich</option>
            <option value="yearly">Jährlich</option>
          </select>
        </Field>
        <Field
          label="Setup-Gebühr in €"
          htmlFor="setupFeeEur"
          help="Leer lassen übernimmt die Gebühr aus dem Plan."
        >
          <input
            id="setupFeeEur"
            name="setupFeeEur"
            type="text"
            inputMode="decimal"
            placeholder="aus Plan"
            defaultValue={subscription?.setupFeeEur != null ? String(subscription.setupFeeEur) : ''}
          />
        </Field>
      </form>
      {subscription ? (
        // its own form below the assignment: removing is the rare, destructive path
        <form action={removeSubscription} className="plan-remove row row--between">
          <input type="hidden" name="orgId" value={orgId} />
          {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
          <span className="muted small grow">
            Entfernt Plan und Preisliste. Die Kanal-Kontingente bleiben bestehen.
          </span>
          <Button type="submit" variant="danger" size="sm">
            Zuweisung entfernen
          </Button>
        </form>
      ) : null}
    </Drawer>
  );
}
