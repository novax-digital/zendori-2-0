// "Zahlung und Rechnungsdaten" on the customer's billing page (Phase 15a).
// Shown only once the operator enabled Stripe billing for the organization.
// Server components; the two forms post to the actions next door.
import {
  EU_COUNTRY_LABELS,
  HOME_COUNTRY,
  VAT_ID_STATUS_LABELS,
  isEuCountry,
  isVatIdAccepted,
  type BillingAccountRow,
  type VatIdStatus,
} from '@zendori/core';
import {
  vatIdCheckOf,
  type BillingAccountState,
  type StripeCustomerState,
} from '@/lib/billing-account';
import BillingDetailsFields from '@/components/billing/BillingDetailsFields';
import BillingSyncPoller from '@/components/billing/BillingSyncPoller';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Property, PropertyList, Section } from '@/components/ui/Layout';
import { saveBillingDetails, startPaymentSetup } from './actions';

const VAT_STATUS_TONE: Record<VatIdStatus, BadgeTone> = {
  pending: 'info',
  verified: 'success',
  unverified: 'danger',
  unavailable: 'warn',
};

export function VatIdBadge({
  vatId,
  stripe,
}: {
  vatId: string;
  stripe: StripeCustomerState | null;
}) {
  const check = vatIdCheckOf(vatId, stripe);
  if (check?.confirmed) {
    return (
      <Badge tone="success" dot>
        Bestätigt
      </Badge>
    );
  }
  if (!check || check.value !== vatId || !check.status) {
    return <Badge tone="muted">Noch nicht geprüft</Badge>;
  }
  return (
    <Badge tone={VAT_STATUS_TONE[check.status]} dot>
      {VAT_ID_STATUS_LABELS[check.status]}
    </Badge>
  );
}

export default function StripeBillingSection({
  orgId,
  canEdit,
  livemode,
  state,
  editHref,
  doneHref,
  awaitingPayment,
}: {
  orgId: string;
  /** Owner or admin of the organization. */
  canEdit: boolean;
  livemode: boolean;
  state: BillingAccountState;
  /** The page with ?panel=details. */
  editHref: string;
  /** The page without the ?payment= marker. */
  doneHref: string;
  /** The customer just came back from Stripe's payment page. */
  awaitingPayment: boolean;
}) {
  const stripe = state.stripe;
  if (!stripe) return null;
  const details = state.details;
  const foreign = details !== null && details.country !== HOME_COUNTRY;
  const vatAccepted =
    details !== null && isVatIdAccepted(details.vatId, vatIdCheckOf(details.vatId, stripe));
  const hasStored = state.stored !== null && Object.values(state.stored).some((v) => v);

  return (
    <Section
      title="Zahlung und Rechnungsdaten"
      help="Rechnungen stellen wir monatlich für den Vormonat. Mit hinterlegter Zahlungsart ziehen wir den Betrag automatisch ein."
    >
      {livemode ? null : (
        <Callout tone="warn">
          Testmodus: Hier hinterlegte Zahlungsarten werden nicht belastet, es entstehen keine echten
          Rechnungen.
        </Callout>
      )}
      {stripe.syncPending || awaitingPayment ? (
        <BillingSyncPoller
          orgId={orgId}
          awaitPaymentMethod={awaitingPayment}
          knownPaymentMethodId={stripe.paymentMethodId}
          doneHref={doneHref}
        />
      ) : null}
      {details === null ? (
        <Callout tone="warn">
          {hasStored
            ? 'Deine Rechnungsdaten sind unvollständig. Ohne vollständige Angaben können wir keine Rechnung stellen.'
            : 'Bitte hinterlege deine Rechnungsdaten. Ohne sie können wir keine Rechnung stellen.'}
        </Callout>
      ) : null}
      {foreign && !vatAccepted && !stripe.syncPending ? (
        <Callout tone="warn">
          Deine USt-ID ist noch nicht bestätigt. Solange das so ist, stellen wir keine Rechnung.
          Bitte prüfe die Angabe oder melde dich bei deinem Ansprechpartner.
        </Callout>
      ) : null}

      <PropertyList>
        <Property label="Rechnungsempfänger">
          {details ? (
            <>
              {details.legalName}
              <br />
              {details.addressLine1}
              {details.addressLine2 ? `, ${details.addressLine2}` : ''}
              <br />
              {details.postalCode} {details.city}, {EU_COUNTRY_LABELS[details.country]}
            </>
          ) : (
            <span className="muted">Noch nicht hinterlegt</span>
          )}
        </Property>
        <Property label="USt-ID">
          {details && details.vatId !== '' ? (
            <span className="row">
              {details.vatId} <VatIdBadge vatId={details.vatId} stripe={stripe} />
            </span>
          ) : (
            <span className="muted">Keine</span>
          )}
        </Property>
        <Property label="Rechnungs-E-Mail">
          {details ? details.billingEmail : <span className="muted">Noch nicht hinterlegt</span>}
        </Property>
        <Property label="Zahlungsart">
          {stripe.paymentMethodLabel ?? (
            <span className="muted">
              Keine hinterlegt. Rechnungen kommen dann per E-Mail mit einem Bezahllink.
            </span>
          )}
        </Property>
      </PropertyList>

      {canEdit ? (
        <div className="row">
          <Button href={editHref} scroll={false}>
            Rechnungsdaten bearbeiten
          </Button>
          <form action={startPaymentSetup}>
            <input type="hidden" name="org" value={orgId} />
            <Button type="submit" variant={stripe.paymentMethodId ? 'secondary' : 'primary'}>
              {stripe.paymentMethodId ? 'Zahlungsart ändern' : 'Zahlungsart hinterlegen'}
            </Button>
          </form>
        </div>
      ) : (
        <p className="muted small">Nur Inhaber und Admins können diese Angaben ändern.</p>
      )}
      {canEdit ? (
        <p className="muted small">
          Die Zahlungsart gibst du auf der Seite unseres Zahlungsanbieters Stripe ein
          (SEPA-Lastschrift oder Karte). Wir speichern nur die Art und die letzten vier Stellen.
        </p>
      ) : null}
    </Section>
  );
}

export function BillingDetailsDrawer({
  orgId,
  closeHref,
  stored,
  error,
}: {
  orgId: string;
  /** The page without the panel parameter. */
  closeHref: string;
  stored: BillingAccountRow | null;
  /** Error of the last submit (the action redirects back with panel=details). */
  error?: string;
}) {
  // a stored country that is no longer billable falls back to the default
  const safeStored =
    stored && stored.country !== null && !isEuCountry(stored.country)
      ? { ...stored, country: null }
      : stored;
  return (
    <Drawer
      title="Rechnungsdaten"
      closeHref={closeHref}
      footer={
        <>
          <Button href={closeHref} scroll={false}>
            Abbrechen
          </Button>
          <Button type="submit" form="billing-details" variant="primary">
            Speichern
          </Button>
        </>
      }
    >
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <form id="billing-details" action={saveBillingDetails} className="stack">
        <input type="hidden" name="org" value={orgId} />
        <BillingDetailsFields idPrefix="billing" stored={safeStored} />
      </form>
    </Drawer>
  );
}
