// Stripe billing of one customer, operator side (Phase 15a): the rail block on
// Abrechnung → Kunde and the "Stripe-Abrechnung" drawer (?panel=stripe). The
// switch and the first month apply to the CURRENT Stripe mode only — enabling a
// customer with test keys never bills it for real after the switch to live keys.
import { HOME_COUNTRY, isVatIdAccepted, type BillingAccountRow } from '@zendori/core';
import {
  stripeDashboardCustomerUrl,
  vatIdCheckOf,
  type BillingAccountState,
} from '@/lib/billing-account';
import BillingDetailsFields from '@/components/billing/BillingDetailsFields';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field, SettingRow } from '@/components/ui/Field';
import { Property, PropertyList } from '@/components/ui/Layout';
import { VatIdBadge } from '@/app/settings/billing/StripeBillingSection';
import { confirmVatId, saveStripeBilling } from '../billing/actions';

export interface MonthChoice {
  key: string;
  label: string;
}

export function StripeBillingSummary({
  orgId,
  livemode,
  state,
  fromLabel,
  changeHref,
}: {
  orgId: string;
  /** null = Stripe is not configured (no STRIPE_SECRET_KEY). */
  livemode: boolean | null;
  state: BillingAccountState | null;
  /** Label of the first billing month, if set. */
  fromLabel: string | null;
  /** The page with ?panel=stripe. */
  changeHref: string;
}) {
  if (livemode === null) {
    return (
      <div className="rail-section">
        <h2>Stripe-Abrechnung</h2>
        <p className="muted small">
          Stripe ist nicht eingerichtet (STRIPE_SECRET_KEY fehlt). Rechnungen entstehen nicht
          automatisch.
        </p>
      </div>
    );
  }
  if (!state || !state.available) {
    return (
      <div className="rail-section">
        <h2>Stripe-Abrechnung</h2>
        <p className="muted small">Noch nicht verfügbar (Migration 0041 ausstehend).</p>
      </div>
    );
  }

  const stripe = state.stripe;
  const details = state.details;
  const enabled = stripe?.enabled === true;
  const foreign = details !== null && details.country !== HOME_COUNTRY;
  const vatAccepted =
    details !== null && isVatIdAccepted(details.vatId, vatIdCheckOf(details.vatId, stripe));

  return (
    <div className="rail-section">
      <h2>Stripe-Abrechnung</h2>
      {livemode ? null : (
        <p>
          <Badge tone="warn">Testmodus</Badge>
        </p>
      )}
      <PropertyList>
        <Property label="Status">
          {enabled ? (
            <Badge tone="success" dot>
              Aktiv
            </Badge>
          ) : (
            <Badge tone="muted">Aus</Badge>
          )}
        </Property>
        <Property label="Ab Monat">{fromLabel ?? '—'}</Property>
        <Property label="Rechnungsdaten">
          {details ? 'Vollständig' : <span className="muted">Fehlen</span>}
        </Property>
        <Property label="USt-ID">
          {details && details.vatId !== '' ? (
            <>
              {details.vatId} <VatIdBadge vatId={details.vatId} stripe={stripe} />
            </>
          ) : (
            <span className="muted">Keine</span>
          )}
        </Property>
        <Property label="Zahlungsart">
          {stripe?.paymentMethodLabel ?? <span className="muted">Keine</span>}
        </Property>
        {stripe?.syncPending ? <Property label="Abgleich">läuft …</Property> : null}
        {stripe?.syncError ? (
          <Property label="Abgleich">
            <span className="muted">Fehler ({stripe.syncError})</span>
          </Property>
        ) : null}
      </PropertyList>
      <div className="row">
        <Button href={changeHref} size="sm" scroll={false}>
          {enabled ? 'Ändern' : 'Einrichten'}
        </Button>
        {stripe?.stripeCustomerId ? (
          <a
            className="small"
            href={stripeDashboardCustomerUrl(stripe.stripeCustomerId, livemode)}
            target="_blank"
            rel="noreferrer"
          >
            In Stripe öffnen
          </a>
        ) : null}
      </div>
      {enabled && foreign && !vatAccepted ? (
        <form action={confirmVatId} className="stack">
          <input type="hidden" name="orgId" value={orgId} />
          <p className="muted small">
            Ohne bestätigte USt-ID wird dieser Kunde nicht abgerechnet. Hast du sie selbst geprüft,
            kannst du sie hier bestätigen.
          </p>
          <div>
            <Button type="submit" size="sm">
              USt-ID bestätigen
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

export function StripeBillingDrawer({
  orgId,
  closeHref,
  livemode,
  enabled,
  invoiceFrom,
  months,
  stored,
  error,
}: {
  orgId: string;
  /** The page without the panel parameter. */
  closeHref: string;
  livemode: boolean;
  enabled: boolean;
  /** Stored first month (YYYY-MM) or the suggested default. */
  invoiceFrom: string;
  /** Selectable first months; contains `invoiceFrom`. */
  months: MonthChoice[];
  stored: BillingAccountRow | null;
  /** Error of the last submit (the action redirects back with panel=stripe). */
  error?: string;
}) {
  return (
    <Drawer
      title="Stripe-Abrechnung"
      closeHref={closeHref}
      footer={
        <>
          <Button href={closeHref} scroll={false}>
            Abbrechen
          </Button>
          <Button type="submit" form="stripe-billing" variant="primary">
            Speichern
          </Button>
        </>
      }
    >
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {livemode ? null : (
        <Callout tone="warn">
          Stripe läuft im Testmodus. Der Schalter gilt nur für den Testmodus — nach dem Wechsel auf
          Live-Schlüssel aktivierst du den Kunden hier erneut.
        </Callout>
      )}
      <form id="stripe-billing" action={saveStripeBilling} className="stack">
        <input type="hidden" name="orgId" value={orgId} />
        <SettingRow
          label="Über Stripe abrechnen"
          help="Der Kunde sieht dann unter Einstellungen → Abrechnung die Bereiche für Rechnungsdaten und Zahlungsart."
          htmlFor="stripe-enabled"
        >
          <input
            id="stripe-enabled"
            name="enabled"
            type="checkbox"
            className="switch"
            defaultChecked={enabled}
          />
        </SettingRow>
        <Field
          label="Ab Monat"
          htmlFor="stripe-from"
          help="Der erste Monat, der über Stripe abgerechnet wird. Frühere Monate bleiben unberührt."
        >
          <select id="stripe-from" name="invoiceFrom" defaultValue={invoiceFrom}>
            {months.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
        </Field>
        <h3>Rechnungsdaten</h3>
        <p className="muted small">
          Optional: Du kannst die Angaben für den Kunden eintragen. Leer lassen, wenn der Kunde sie
          selbst hinterlegt.
        </p>
        <BillingDetailsFields idPrefix="stripe-details" stored={stored} required={false} />
      </form>
    </Drawer>
  );
}
