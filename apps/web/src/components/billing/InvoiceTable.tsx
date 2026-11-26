// The list of invoices (Phase 15b), used in three places: Plattform →
// Rechnungen (all customers), Abrechnung → Kunde (one customer, operator) and
// Einstellungen → Abrechnung (the customer's own). The operator gets the
// actions (paid / open, send again, cancel); the customer gets status and PDF.
import Link from 'next/link';
import {
  INVOICE_DISPLAY_STATUS_LABELS,
  collectErrorLabel,
  formatCentsEur,
  formatDateDe,
  invoiceDisplayStatus,
  invoicePeriodLabel,
  type BillingInvoice,
  type InvoiceDisplayStatus,
} from '@zendori/core';
import {
  cancelInvoiceAction,
  markInvoicePaid,
  resendInvoice,
  retryInvoiceCollection,
} from '@/app/admin/invoices/actions';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Menu from '@/components/ui/Menu';

const STATUS_TONE: Record<InvoiceDisplayStatus, BadgeTone> = {
  paid: 'success',
  open: 'neutral',
  overdue: 'danger',
  cancelled: 'muted',
  cancellation: 'muted',
};

const MAIL_ERROR_LABELS: Record<string, string> = {
  not_configured: 'Absender fehlt (RESEND_FROM im Worker)',
  no_recipient: 'keine Rechnungs-E-Mail',
  send_failed: 'Versand fehlgeschlagen',
};

/** What happened to the PDF and the mail, in a few words (operator view). */
function deliveryText(invoice: BillingInvoice): string {
  if (invoice.pdfState === 'pending') return 'PDF wird erzeugt …';
  if (invoice.pdfState === 'failed') return 'PDF fehlgeschlagen';
  if (invoice.mailState === 'pending') return 'wird gesendet …';
  if (invoice.mailState === 'failed') {
    return `nicht gesendet: ${MAIL_ERROR_LABELS[invoice.mailError ?? ''] ?? 'Fehler'}`;
  }
  if (invoice.mailState === 'sent') {
    return `gesendet an ${invoice.mailTo ?? '—'}`;
  }
  return 'nicht gesendet';
}

/**
 * Where the charge through Stripe stands, in a few words; null for an invoice
 * that is paid by transfer. The customer sees no internal reason codes.
 */
function collectionText(invoice: BillingInvoice, mode: 'admin' | 'customer'): string | null {
  switch (invoice.collectState) {
    case 'scheduled':
      return invoice.collectOn ? `Einzug ab ${formatDateDe(invoice.collectOn)}` : 'Einzug geplant';
    case 'processing':
      return 'Einzug läuft';
    case 'failed':
      return mode === 'admin'
        ? `Einzug fehlgeschlagen: ${collectErrorLabel(invoice.collectError)}`
        : 'Einzug fehlgeschlagen — bitte prüfe deine Zahlungsart';
    case 'disputed':
      return 'Zahlung zurückgebucht';
    default:
      return null;
  }
}

export default function InvoiceTable({
  invoices,
  today,
  mode,
  showCustomer = false,
  returnTo,
}: {
  invoices: BillingInvoice[];
  /** YYYY-MM-DD in Germany (berlinDate) — decides "überfällig". */
  today: string;
  mode: 'admin' | 'customer';
  /** Column "Kunde" (the list across all customers). */
  showCustomer?: boolean;
  /** Admin: the page the actions return to. */
  returnTo?: string;
}) {
  const numberOf = new Map(invoices.map((invoice) => [invoice.id, invoice.number]));
  return (
    <div className="table-wrap">
      <table className="table--compact">
        <thead>
          <tr>
            <th>Nummer</th>
            {showCustomer ? <th>Kunde</th> : null}
            <th>Monat</th>
            <th>Datum</th>
            <th className="num">Betrag</th>
            <th>Status</th>
            {mode === 'admin' ? <th>Versand</th> : null}
            <th />
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => {
            const status = invoiceDisplayStatus(invoice, today);
            const pdfHref = `/api/billing/invoices/${invoice.id}/pdf`;
            const hidden = (
              <>
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <input type="hidden" name="orgId" value={invoice.orgId ?? ''} />
                {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
              </>
            );
            return (
              <tr key={invoice.id}>
                <td>
                  {invoice.pdfState === 'ready' ? (
                    <a className="cell-title" href={pdfHref} target="_blank" rel="noreferrer">
                      {invoice.number}
                    </a>
                  ) : (
                    <span className="cell-title">{invoice.number}</span>
                  )}
                  {invoice.kind === 'cancellation' && invoice.cancelsInvoiceId ? (
                    <div className="cell-sub">
                      zu {numberOf.get(invoice.cancelsInvoiceId) ?? 'einer Rechnung'}
                    </div>
                  ) : null}
                </td>
                {showCustomer ? (
                  <td>
                    {invoice.orgId ? (
                      <Link href={`/admin/billing/${invoice.orgId}`}>
                        {invoice.recipient.legalName}
                      </Link>
                    ) : (
                      <>
                        {invoice.recipient.legalName}
                        <div className="cell-sub">Organisation gelöscht</div>
                      </>
                    )}
                  </td>
                ) : null}
                <td>{invoicePeriodLabel(invoice.period)}</td>
                <td className="muted">{formatDateDe(invoice.issueDate)}</td>
                <td className="num strong">
                  {formatCentsEur(invoice.grossCents)}
                  <div className="cell-sub">netto {formatCentsEur(invoice.netCents)}</div>
                </td>
                <td>
                  <Badge tone={STATUS_TONE[status]} dot={status !== 'cancellation'}>
                    {INVOICE_DISPLAY_STATUS_LABELS[status]}
                  </Badge>
                  {status === 'open' || status === 'overdue' ? (
                    collectionText(invoice, mode) ? (
                      <div className="cell-sub">{collectionText(invoice, mode)}</div>
                    ) : invoice.dueDate ? (
                      <div className="cell-sub">fällig am {formatDateDe(invoice.dueDate)}</div>
                    ) : null
                  ) : status === 'paid' && invoice.paidAt ? (
                    <div className="cell-sub">
                      am {formatDateDe(invoice.paidAt.slice(0, 10))}
                      {invoice.paidVia === 'stripe' ? ' · eingezogen' : ''}
                      {mode === 'admin' && invoice.paidNote ? ` · ${invoice.paidNote}` : ''}
                    </div>
                  ) : null}
                </td>
                {mode === 'admin' ? <td className="muted">{deliveryText(invoice)}</td> : null}
                <td className="cell-actions">
                  {mode === 'customer' ? (
                    invoice.pdfState === 'ready' ? (
                      <a className="btn btn--sm" href={pdfHref} target="_blank" rel="noreferrer">
                        PDF
                      </a>
                    ) : (
                      <span className="muted small">PDF wird erzeugt …</span>
                    )
                  ) : (
                    <Menu label={`Aktionen für ${invoice.number}`}>
                      {invoice.pdfState === 'ready' ? (
                        <a className="menu-item" href={pdfHref} target="_blank" rel="noreferrer">
                          <span className="menu-label">PDF öffnen</span>
                        </a>
                      ) : null}
                      {(status === 'open' || status === 'overdue') &&
                      invoice.collectState === 'failed' ? (
                        <form action={retryInvoiceCollection}>
                          {hidden}
                          <p className="menu-note">
                            Versucht den Einzug über Stripe noch einmal, von der Zahlungsart, die
                            der Kunde jetzt hinterlegt hat.
                          </p>
                          <button className="menu-item" type="submit">
                            <span className="menu-label">Einzug erneut versuchen</span>
                          </button>
                        </form>
                      ) : null}
                      {/* not while a debit is under way: it would be paid twice */}
                      {(status === 'open' || status === 'overdue') &&
                      invoice.collectState !== 'processing' ? (
                        <form action={markInvoicePaid}>
                          {hidden}
                          <input type="hidden" name="paid" value="true" />
                          <button className="menu-item" type="submit">
                            <span className="menu-label">Als bezahlt markieren</span>
                          </button>
                        </form>
                      ) : null}
                      {status === 'paid' && invoice.paidVia === 'manual' ? (
                        <form action={markInvoicePaid}>
                          {hidden}
                          <input type="hidden" name="paid" value="false" />
                          <button className="menu-item" type="submit">
                            <span className="menu-label">Wieder als offen markieren</span>
                          </button>
                        </form>
                      ) : null}
                      <form action={resendInvoice}>
                        {hidden}
                        <button className="menu-item" type="submit">
                          <span className="menu-label">
                            {invoice.mailState === 'sent' ? 'Erneut senden' : 'Per E-Mail senden'}
                          </span>
                        </button>
                      </form>
                      {invoice.kind === 'invoice' && invoice.cancelledByInvoiceId === null ? (
                        <form action={cancelInvoiceAction}>
                          {hidden}
                          <p className="menu-note">
                            Stornieren erzeugt eine Stornorechnung mit eigener Nummer. Die Rechnung
                            selbst bleibt erhalten.
                          </p>
                          <ConfirmDeleteButton
                            inMenu
                            label="Stornieren"
                            confirmLabel="Endgültig stornieren"
                          />
                        </form>
                      ) : null}
                    </Menu>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
