// Plattform → Rechnungen → Rechnungssteller (Phase 15b): what stands on every
// invoice as the seller — company, tax and bank details — plus the number
// format and the payment term. Changes apply to invoices issued from now on;
// an issued invoice keeps the details it was issued with.
import { DEFAULT_INVOICE_NUMBER_FORMAT, formatInvoiceNumber } from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { loadSellerState } from '@/lib/invoices';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import DismissibleBanners from '@/components/DismissibleBanners';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { Field } from '@/components/ui/Field';
import { Section } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import AdminUnavailable from '../../_components/AdminUnavailable';
import { saveSeller } from '../actions';

export default async function AdminSellerPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  await requirePlatformAdmin();
  const { error, notice } = await searchParams;
  const admin = createSupabaseAdminClient();
  if (!admin) return <AdminUnavailable title="Rechnungssteller" />;

  const state = await loadSellerState(admin);
  const { seller, numberFormat, numberStart, paymentTermDays } = state.settings;
  const year = new Date().getFullYear();

  const text = (
    name: string,
    label: string,
    value: string,
    options: { help?: string; placeholder?: string; maxLength?: number; type?: string } = {}
  ) => (
    <Field label={label} htmlFor={`seller-${name}`} help={options.help}>
      <input
        id={`seller-${name}`}
        name={name}
        type={options.type ?? 'text'}
        defaultValue={value}
        maxLength={options.maxLength ?? 200}
        placeholder={options.placeholder}
      />
    </Field>
  );

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: 'Rechnungen', href: '/admin/invoices' }, { label: 'Rechnungssteller' }]}
        title="Rechnungssteller"
        subtitle="Diese Angaben stehen auf jeder Rechnung. Sie gelten für neue Rechnungen; eine erstellte Rechnung behält ihre Angaben."
      />
      <form className="page-form" action={saveSeller}>
        <div className="page-body">
          <DismissibleBanners error={error} notice={notice} />
          {!state.available ? (
            <Callout>Noch nicht verfügbar (Migration 0046 ausstehend).</Callout>
          ) : state.missing.length > 0 ? (
            <Callout tone="warn" title="Noch nicht vollständig">
              Es fehlt: {state.missing.join(', ')}. Vorher lässt sich keine Rechnung erstellen.
            </Callout>
          ) : null}

          <div className="form-narrow">
            <Section title="Unternehmen">
              {text('legalName', 'Firmenname', seller.legalName, { maxLength: 150 })}
              {text('addressLine1', 'Straße und Hausnummer', seller.addressLine1)}
              {text('addressLine2', 'Adresszusatz (optional)', seller.addressLine2)}
              <div className="field-row">
                {text('postalCode', 'PLZ', seller.postalCode, { maxLength: 20 })}
                {text('city', 'Ort', seller.city, { maxLength: 100 })}
              </div>
              <input type="hidden" name="country" value={seller.country || 'DE'} />
              <div className="field-row">
                {text('email', 'E-Mail', seller.email, {
                  type: 'email',
                  maxLength: 254,
                  help: 'Steht auf der Rechnung; Antworten auf die Rechnungsmail gehen hierhin.',
                })}
                {text('phone', 'Telefon (optional)', seller.phone, { maxLength: 60 })}
              </div>
              {text('website', 'Website (optional)', seller.website, { maxLength: 120 })}
            </Section>

            <Section
              title="Steuer und Register"
              help="Auf einer Rechnung muss die USt-ID oder die Steuernummer stehen."
            >
              <div className="field-row">
                {text('vatId', 'USt-ID', seller.vatId, { maxLength: 40, placeholder: 'DE123456789' })}
                {text('taxNumber', 'Steuernummer', seller.taxNumber, { maxLength: 40 })}
              </div>
              <div className="field-row">
                {text('registerCourt', 'Registergericht', seller.registerCourt, { maxLength: 100 })}
                {text('registerNumber', 'Registernummer', seller.registerNumber, { maxLength: 60 })}
              </div>
              {text('managingDirectors', 'Geschäftsführung', seller.managingDirectors)}
            </Section>

            <Section
              title="Bankverbindung"
              help="Dorthin überweisen Kunden den Rechnungsbetrag. Die Rechnungsnummer ist der Verwendungszweck."
            >
              {text('bankName', 'Bank', seller.bankName, { maxLength: 120 })}
              <div className="field-row">
                {text('iban', 'IBAN', seller.iban, { maxLength: 42, placeholder: 'DE00 0000 0000 0000 0000 00' })}
                {text('bic', 'BIC', seller.bic, { maxLength: 20 })}
              </div>
            </Section>

            <Section title="Rechnungsnummer und Zahlungsziel">
              <Field
                label="Format der Rechnungsnummer"
                htmlFor="seller-numberFormat"
                help={`{YYYY} oder {YY} = Jahr, {NNNN} = laufende Nummer mit so vielen Stellen wie N. Beispiel mit dem gespeicherten Format: ${formatInvoiceNumber(numberFormat, year, numberStart)}. Jedes Jahr beginnt die Nummer neu.`}
              >
                <input
                  id="seller-numberFormat"
                  name="numberFormat"
                  type="text"
                  required
                  maxLength={40}
                  defaultValue={numberFormat}
                  placeholder={DEFAULT_INVOICE_NUMBER_FORMAT}
                />
              </Field>
              <div className="field-row">
                <Field
                  label="Erste Nummer eines Jahres"
                  htmlFor="seller-numberStart"
                  help="Gilt für ein Jahr, in dem es noch keine Rechnung gibt."
                >
                  <input
                    id="seller-numberStart"
                    name="numberStart"
                    type="number"
                    min={1}
                    step={1}
                    required
                    defaultValue={numberStart}
                  />
                </Field>
                <Field label="Zahlungsziel in Tagen" htmlFor="seller-paymentTermDays">
                  <input
                    id="seller-paymentTermDays"
                    name="paymentTermDays"
                    type="number"
                    min={0}
                    max={90}
                    step={1}
                    required
                    defaultValue={paymentTermDays}
                  />
                </Field>
              </div>
              <Field
                label="Hinweis am Ende der Rechnung (optional)"
                htmlFor="seller-footerNote"
              >
                <textarea
                  id="seller-footerNote"
                  name="footerNote"
                  rows={2}
                  maxLength={500}
                  defaultValue={seller.footerNote}
                />
              </Field>
            </Section>
          </div>
        </div>

        <div className="save-bar">
          <Button type="submit" variant="primary">
            Speichern
          </Button>
          <span className="muted small">Gilt für alle Rechnungen, die ab jetzt erstellt werden.</span>
        </div>
      </form>
    </div>
  );
}
