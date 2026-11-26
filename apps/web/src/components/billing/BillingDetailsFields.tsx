// The billing details of an organization as form fields (Phase 15a). Used in
// two drawers: Einstellungen → Abrechnung (customer) and Admin → Abrechnung →
// Kunde (operator). Plain inputs of the surrounding server-action form; the
// field names are read by billingDetailsFromForm (lib/billing-account.ts).
import { EU_COUNTRIES, EU_COUNTRY_LABELS, type BillingAccountRow } from '@zendori/core';
import { Field } from '@/components/ui/Field';

const COUNTRY_OPTIONS = [...EU_COUNTRIES].sort((a, b) =>
  EU_COUNTRY_LABELS[a].localeCompare(EU_COUNTRY_LABELS[b], 'de')
);

export default function BillingDetailsFields({
  idPrefix,
  stored,
  required = true,
}: {
  idPrefix: string;
  /** What is on file (complete or not); null = nothing yet. */
  stored: BillingAccountRow | null;
  /** false: the operator may leave the whole block empty. */
  required?: boolean;
}) {
  return (
    <>
      <Field
        label="Firmenname"
        htmlFor={`${idPrefix}-legal-name`}
        help="So steht der Empfänger auf der Rechnung."
      >
        <input
          id={`${idPrefix}-legal-name`}
          name="legalName"
          type="text"
          required={required}
          maxLength={150}
          autoComplete="organization"
          defaultValue={stored?.legal_name ?? ''}
        />
      </Field>
      <Field label="Straße und Hausnummer" htmlFor={`${idPrefix}-line1`}>
        <input
          id={`${idPrefix}-line1`}
          name="addressLine1"
          type="text"
          required={required}
          maxLength={200}
          autoComplete="address-line1"
          defaultValue={stored?.address_line1 ?? ''}
        />
      </Field>
      <Field label="Adresszusatz (optional)" htmlFor={`${idPrefix}-line2`}>
        <input
          id={`${idPrefix}-line2`}
          name="addressLine2"
          type="text"
          maxLength={200}
          autoComplete="address-line2"
          defaultValue={stored?.address_line2 ?? ''}
        />
      </Field>
      <Field label="Postleitzahl" htmlFor={`${idPrefix}-postal`}>
        <input
          id={`${idPrefix}-postal`}
          name="postalCode"
          type="text"
          required={required}
          maxLength={20}
          autoComplete="postal-code"
          defaultValue={stored?.postal_code ?? ''}
        />
      </Field>
      <Field label="Ort" htmlFor={`${idPrefix}-city`}>
        <input
          id={`${idPrefix}-city`}
          name="city"
          type="text"
          required={required}
          maxLength={100}
          autoComplete="address-level2"
          defaultValue={stored?.city ?? ''}
        />
      </Field>
      <Field
        label="Land"
        htmlFor={`${idPrefix}-country`}
        help="Abgerechnet werden Unternehmen in Deutschland und der EU."
      >
        <select
          id={`${idPrefix}-country`}
          name="country"
          required={required}
          autoComplete="country"
          defaultValue={stored?.country ?? (required ? 'DE' : '')}
        >
          {required ? null : <option value="">— nicht angegeben —</option>}
          {COUNTRY_OPTIONS.map((code) => (
            <option key={code} value={code}>
              {EU_COUNTRY_LABELS[code]}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="USt-ID"
        htmlFor={`${idPrefix}-vat`}
        help="In Deutschland optional. Außerhalb Deutschlands erforderlich: Die Rechnung wird dann ohne Umsatzsteuer gestellt (Reverse Charge), sobald die USt-ID bestätigt ist."
      >
        <input
          id={`${idPrefix}-vat`}
          name="vatId"
          type="text"
          maxLength={40}
          placeholder="DE123456789"
          autoCapitalize="characters"
          spellCheck={false}
          defaultValue={stored?.vat_id ?? ''}
        />
      </Field>
      <Field
        label="Rechnungs-E-Mail"
        htmlFor={`${idPrefix}-email`}
        help="An diese Adresse gehen die Rechnungen."
      >
        <input
          id={`${idPrefix}-email`}
          name="billingEmail"
          type="email"
          required={required}
          maxLength={254}
          autoComplete="email"
          defaultValue={stored?.billing_email ?? ''}
        />
      </Field>
    </>
  );
}
