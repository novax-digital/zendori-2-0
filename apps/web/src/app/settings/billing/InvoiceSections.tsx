// Einstellungen → Abrechnung, the invoice part (Phase 15b): who the invoices go
// to (shown here for organizations without Stripe billing — with it,
// StripeBillingSection shows the same details next to the payment method) and
// the invoices Zendori has issued, with their state and the PDF.
import { EU_COUNTRY_LABELS, isEuCountry, type BillingInvoice } from '@zendori/core';
import type { BillingRecipientState } from '@/lib/invoices';
import InvoiceTable from '@/components/billing/InvoiceTable';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { EmptyState, Property, PropertyList, Section } from '@/components/ui/Layout';

export function BillingRecipientSection({
  recipient,
  canEdit,
  editHref,
}: {
  recipient: BillingRecipientState;
  canEdit: boolean;
  /** The page with ?panel=details. */
  editHref: string;
}) {
  const details = recipient.details;
  return (
    <Section
      title="Rechnungsdaten"
      help="So stehst du auf der Rechnung. An die Rechnungs-E-Mail senden wir jede Rechnung als PDF."
    >
      {details === null ? (
        <Callout tone="warn">
          {recipient.stored
            ? 'Deine Rechnungsdaten sind unvollständig. Ohne vollständige Angaben können wir keine Rechnung stellen.'
            : 'Bitte hinterlege deine Rechnungsdaten. Ohne sie können wir keine Rechnung stellen.'}
        </Callout>
      ) : null}
      <PropertyList>
        <Property label="Firma">
          {details ? details.legalName : <span className="muted">Noch nicht hinterlegt</span>}
        </Property>
        <Property label="Adresse">
          {details ? (
            <>
              {details.addressLine1}
              {details.addressLine2 ? `, ${details.addressLine2}` : ''}, {details.postalCode}{' '}
              {details.city},{' '}
              {isEuCountry(details.country) ? EU_COUNTRY_LABELS[details.country] : details.country}
            </>
          ) : (
            <span className="muted">Noch nicht hinterlegt</span>
          )}
        </Property>
        <Property label="USt-ID">
          {details && details.vatId !== '' ? details.vatId : <span className="muted">Keine</span>}
        </Property>
        <Property label="Rechnungs-E-Mail">
          {details ? details.billingEmail : <span className="muted">Noch nicht hinterlegt</span>}
        </Property>
      </PropertyList>
      {canEdit ? (
        <div className="row">
          <Button href={editHref} scroll={false} variant={details ? 'secondary' : 'primary'}>
            {recipient.stored ? 'Rechnungsdaten bearbeiten' : 'Rechnungsdaten hinterlegen'}
          </Button>
        </div>
      ) : (
        <p className="muted small">Nur Inhaber und Admins können diese Angaben ändern.</p>
      )}
    </Section>
  );
}

export function CustomerInvoicesSection({
  invoices,
  today,
}: {
  invoices: BillingInvoice[];
  /** YYYY-MM-DD in Germany. */
  today: string;
}) {
  return (
    <Section
      title="Rechnungen"
      help="Deine Rechnungen als PDF. Eine Rechnung kommt außerdem per E-Mail an deine Rechnungs-E-Mail."
    >
      {invoices.length === 0 ? (
        <EmptyState title="Noch keine Rechnung" />
      ) : (
        <InvoiceTable invoices={invoices} today={today} mode="customer" />
      )}
    </Section>
  );
}
