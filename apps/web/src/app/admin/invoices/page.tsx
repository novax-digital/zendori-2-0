// Plattform → Rechnungen (Phase 15b): every invoice Zendori has issued, across
// all customers, with what is open and what is paid. Invoices are created on
// the customer's page (Abrechnung → Kunde) or here, for a customer and a
// finished month; the seller's own details live one click away.
import {
  berlinDate,
  formatCentsEur,
  invoiceDisplayStatus,
  type InvoiceDisplayStatus,
} from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { invoiceableMonths, listInvoices, loadSellerState } from '@/lib/invoices';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import InvoiceTable from '@/components/billing/InvoiceTable';
import DismissibleBanners from '@/components/DismissibleBanners';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { EmptyState, Section, Stat, Stats } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import AdminUnavailable from '../_components/AdminUnavailable';
import { createInvoice } from './actions';

const BASE = '/admin/invoices';

const FILTERS: { key: string; label: string; match: (status: InvoiceDisplayStatus) => boolean }[] = [
  { key: 'all', label: 'Alle', match: () => true },
  { key: 'open', label: 'Offen', match: (status) => status === 'open' || status === 'overdue' },
  { key: 'overdue', label: 'Überfällig', match: (status) => status === 'overdue' },
  { key: 'paid', label: 'Bezahlt', match: (status) => status === 'paid' },
  {
    key: 'cancelled',
    label: 'Storniert',
    match: (status) => status === 'cancelled' || status === 'cancellation',
  },
];

export default async function AdminInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; panel?: string; error?: string; notice?: string }>;
}) {
  await requirePlatformAdmin();
  const { status, panel, error, notice } = await searchParams;

  const admin = createSupabaseAdminClient();
  if (!admin) return <AdminUnavailable title="Rechnungen" />;

  const [list, seller] = await Promise.all([listInvoices(admin), loadSellerState(admin)]);
  if (!list.available || !seller.available) {
    return (
      <div className="page">
        <PageHeader title="Rechnungen" />
        <div className="page-body">
          <Callout>Rechnungen sind noch nicht verfügbar (Migration 0046 ausstehend).</Callout>
        </div>
      </div>
    );
  }

  const today = berlinDate(new Date());
  const filter = FILTERS.find((f) => f.key === status) ?? FILTERS[0]!;
  const withStatus = list.invoices.map((invoice) => ({
    invoice,
    status: invoiceDisplayStatus(invoice, today),
  }));
  const shown = withStatus.filter((row) => filter.match(row.status)).map((row) => row.invoice);
  const sum = (match: (s: InvoiceDisplayStatus) => boolean): number =>
    withStatus.filter((row) => match(row.status)).reduce((total, row) => total + row.invoice.grossCents, 0);
  const openCents = sum((s) => s === 'open' || s === 'overdue');
  const overdueCents = sum((s) => s === 'overdue');
  const paidCents = sum((s) => s === 'paid');

  const creating = panel === 'new';
  const { data: orgData } = creating
    ? await admin.from('organizations').select('id, name').order('name')
    : { data: [] };
  const orgs = (orgData ?? []) as { id: string; name: string }[];
  const months = invoiceableMonths(new Date());
  const listHref = filter.key === 'all' ? BASE : `${BASE}?status=${filter.key}`;

  return (
    <div className="page">
      <PageHeader
        title="Rechnungen"
        subtitle="Alle Rechnungen, die Zendori gestellt hat — brutto, mit Zahlstatus."
        actions={
          <>
            <Button href={`${BASE}/seller`}>Rechnungssteller</Button>
            <Button href={`${BASE}?panel=new`} variant="primary" icon="plus" scroll={false}>
              Rechnung erstellen
            </Button>
          </>
        }
      />

      <div className="page-body">
        <DismissibleBanners error={creating ? undefined : error} notice={notice} />

        {seller.missing.length > 0 ? (
          <Callout
            tone="warn"
            title="Der Rechnungssteller ist noch nicht vollständig"
            action={
              <Button href={`${BASE}/seller`} size="sm">
                Ergänzen
              </Button>
            }
          >
            Es fehlt: {seller.missing.join(', ')}. Vorher lässt sich keine Rechnung erstellen.
          </Callout>
        ) : null}

        <Section title="Überblick">
          <Stats>
            <Stat label="Offen" value={formatCentsEur(openCents)} note="brutto" />
            <Stat label="Davon überfällig" value={formatCentsEur(overdueCents)} />
            <Stat label="Bezahlt" value={formatCentsEur(paidCents)} />
            <Stat label="Rechnungen" value={String(list.invoices.length)} />
          </Stats>
        </Section>

        <Section
          title="Rechnungen"
          actions={
            <span className="row">
              {FILTERS.map((f) => (
                <Button
                  key={f.key}
                  href={f.key === 'all' ? BASE : `${BASE}?status=${f.key}`}
                  size="sm"
                  variant={f.key === filter.key ? 'primary' : 'secondary'}
                >
                  {f.label}
                </Button>
              ))}
            </span>
          }
        >
          {shown.length === 0 ? (
            <EmptyState
              title={list.invoices.length === 0 ? 'Noch keine Rechnungen' : 'Keine Rechnungen in dieser Ansicht'}
              text={
                list.invoices.length === 0
                  ? 'Eine Rechnung erstellst du für einen Kunden und einen abgeschlossenen Monat.'
                  : undefined
              }
            />
          ) : (
            <InvoiceTable
              invoices={shown}
              today={today}
              mode="admin"
              showCustomer
              returnTo={listHref}
            />
          )}
        </Section>
      </div>

      {creating ? (
        <Drawer
          title="Rechnung erstellen"
          closeHref={listHref}
          footer={
            <>
              <Button href={listHref} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="new-invoice" variant="primary">
                Rechnung erstellen
              </Button>
            </>
          }
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <p className="muted small">
            Zendori rechnet den Monat aus, friert die Positionen ein und vergibt die nächste
            Rechnungsnummer. Danach lässt sich die Rechnung nicht mehr ändern, nur stornieren. Das
            PDF geht an die Rechnungs-E-Mail des Kunden.
          </p>
          <form id="new-invoice" action={createInvoice} className="stack">
            <input type="hidden" name="returnTo" value={`${BASE}?panel=new`} />
            <Field label="Kunde" htmlFor="invoice-org">
              <select id="invoice-org" name="orgId" required defaultValue="">
                <option value="" disabled>
                  Bitte wählen
                </option>
                {orgs.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Monat"
              htmlFor="invoice-period"
              help="Nur abgeschlossene Monate. Je Kunde und Monat gibt es eine Rechnung."
            >
              <select id="invoice-period" name="period" required defaultValue={months[0]?.key}>
                {months.map((month) => (
                  <option key={month.key} value={month.key}>
                    {month.label}
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
