// Stripe billing of one customer, operator side (Phase 15a): the rail block on
// Abrechnung → Kunde and the "Stripe-Abrechnung" drawer (?panel=stripe). The
// switch and the first month apply to the CURRENT Stripe mode only — enabling a
// customer with test keys never bills it for real after the switch to live keys.
import { HOME_COUNTRY, isVatIdAccepted, type BillingAccountRow } from '@zendori/core';
import {
  setupMailErrorLabel,
  stripeDashboardCustomerUrl,
  vatIdCheckOf,
  type BillingAccountState,
  type SetupMailState,
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

const dateFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeZone: 'Europe/Berlin',
});

/** "gesendet am 26.11.2026", "wird gesendet …", or why nothing went out. */
function setupMailText(mail: SetupMailState): string {
  if (mail.pending) return 'wird gesendet …';
  if (mail.error) return `nicht gesendet: ${setupMailErrorLabel(mail.error)}`;
  if (mail.sentAt) return `gesendet am ${dateFormat.format(new Date(mail.sentAt))}`;
  return 'noch nicht gesendet';
}

export function StripeBillingSummary({
  orgId,
  livemode,
  state,
  mail,
  fromLabel,
  changeHref,
}: {
  orgId: string;
  /** null = Stripe is not configured (no STRIPE_SECRET_KEY). */
  livemode: boolean | null;
  state: BillingAccountState | null;
  /** The mail that asks the customer to set up billing (0044); null = not available. */
  mail: SetupMailState | null;
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
          {stripe?.paymentMethodLabel ??
            // required once Stripe billing is on
            (enabled ? <Badge tone="warn">Fehlt</Badge> : <span className="muted">Keine</span>)}
        </Property>
        {enabled && mail?.available ? (
          <Property label="E-Mail an Kunden">
            {mail.error && !mail.pending ? (
              <span className="muted">{setupMailText(mail)}</span>
            ) : (
              setupMailText(mail)
            )}
          </Property>
        ) : null}
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
  mail,
  setupComplete,
  error,
}: {
  orgId: string;
  /** The page without the panel parameter. */
  closeHref: string;
  livemode: boolean;
  enabled: boolean;
  /** The mail that asks the customer to set up billing (0044); null = not available. */
  mail: SetupMailState | null;
  /** Billing details and payment method are both on file: there is nothing to ask for. */
  setupComplete: boolean;
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
          help="Der Kunde muss dann unter Einstellungen → Abrechnung Rechnungsdaten und eine Zahlungsart hinterlegen und sieht dazu einen Hinweis auf jeder Seite. Ohne den Schalter rechnest du diesen Kunden selbst ab; beim Ausschalten wird nichts mehr an Stripe gesendet."
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
        {mail?.available && !setupComplete ? (
          <SettingRow
            label={mail.sentAt ? 'Kunden erneut per E-Mail erinnern' : 'Kunden per E-Mail informieren'}
            help={
              mail.sentAt
                ? `Zuletzt ${setupMailText(mail)}. Inhaber und Admins bekommen die E-Mail mit dem Link zur Abrechnung noch einmal.`
                : 'Inhaber und Admins bekommen eine E-Mail mit dem Link zu Einstellungen → Abrechnung. Darin steht, dass Rechnungsdaten und Zahlungsart für die Abrechnung erforderlich sind. Nur bei eingeschalteter Stripe-Abrechnung.'
            }
            htmlFor="stripe-notify"
          >
            <input
              id="stripe-notify"
              name="notifyCustomer"
              type="checkbox"
              className="switch"
              // on for the first mail (also one that is still waiting), off once it went out
              defaultChecked={mail.pending || (mail.sentAt === null && mail.error === null)}
            />
          </SettingRow>
        ) : null}
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
