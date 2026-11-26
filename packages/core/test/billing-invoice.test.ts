import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELLER,
  addDays,
  berlinDate,
  buildInvoiceAmounts,
  cancellationAmounts,
  collectErrorLabel,
  formatCentsEur,
  formatDateDe,
  formatInvoiceNumber,
  invoiceDisplayStatus,
  invoiceFileName,
  invoicePdfPath,
  invoicePeriodLabel,
  invoiceServicePeriod,
  isInvoiceNumberFormat,
  parseInvoiceRow,
  sellerFromRow,
  sellerMissingFields,
  sellerToRow,
  type InvoiceSeller,
} from '../src/billing-invoice.js';

// Own invoices (migration 0046). These tests pin what ends up on a document
// that cannot be changed afterwards: the amounts, the number, the dates.

const SELLER: InvoiceSeller = {
  ...EMPTY_SELLER,
  legalName: 'Novax Digital GmbH',
  addressLine1: 'Schierholzstr. 27',
  postalCode: '30655',
  city: 'Hannover',
  vatId: 'DE335613731',
  email: 'info@zendori.ai',
  iban: 'DE02120300000000202051',
};

describe('invoice amounts', () => {
  it('rounds every line to cents, sums the net and taxes the net once', () => {
    const amounts = buildInvoiceAmounts({
      fixed: [
        { label: 'WhatsApp (1×)', amountEur: 15 },
        { label: 'Rufnummer Mobil (1×)', amountEur: 30 },
      ],
      usage: [
        { label: 'Telefonie', quantity: '31,5 Minuten', amountEur: 15.75 },
        { label: 'KI-Antworten & Klassifikation', quantity: '7 Vorgänge', amountEur: 0.0693 },
      ],
      taxPercent: 19,
    });
    expect(amounts.lines).toEqual([
      { label: 'WhatsApp (1×)', amountCents: 1500 },
      { label: 'Rufnummer Mobil (1×)', amountCents: 3000 },
      { label: 'Telefonie', quantity: '31,5 Minuten', amountCents: 1575 },
      { label: 'KI-Antworten & Klassifikation', quantity: '7 Vorgänge', amountCents: 7 },
    ]);
    expect(amounts.netCents).toBe(6082);
    expect(amounts.taxCents).toBe(1156); // 19 % of 60.82 = 11.5558
    expect(amounts.grossCents).toBe(7238);
    expect(amounts.netCents + amounts.taxCents).toBe(amounts.grossCents);
  });

  it('leaves out what costs nothing', () => {
    const amounts = buildInvoiceAmounts({
      fixed: [{ label: 'Grundgebühr', amountEur: 0 }],
      usage: [
        { label: 'E-Mail-Versand', quantity: '0 E-Mails', amountEur: 0 },
        { label: 'Data Actions', quantity: '1 Aktionen', amountEur: 0.004 },
      ],
      taxPercent: 19,
    });
    expect(amounts.lines).toEqual([]);
    expect(amounts.grossCents).toBe(0);
  });

  it('reverse charge: no tax, gross equals net', () => {
    const amounts = buildInvoiceAmounts({
      fixed: [{ label: 'Grundgebühr', amountEur: 49 }],
      usage: [],
      taxPercent: 0,
    });
    expect(amounts).toMatchObject({ netCents: 4900, taxCents: 0, grossCents: 4900 });
  });

  it('a cancellation carries the same lines with the opposite sign', () => {
    const original = buildInvoiceAmounts({
      fixed: [{ label: 'WhatsApp (1×)', amountEur: 15 }],
      usage: [{ label: 'Telefonie', quantity: '10 Minuten', amountEur: 5 }],
      taxPercent: 19,
    });
    const cancelled = cancellationAmounts(original);
    expect(cancelled.lines.map((line) => line.amountCents)).toEqual([-1500, -500]);
    expect(cancelled.netCents).toBe(-2000);
    expect(cancelled.taxCents).toBe(-380);
    expect(cancelled.grossCents).toBe(-2380);
    expect(original.grossCents + cancelled.grossCents).toBe(0);
  });
});

describe('invoice number', () => {
  it('writes year and running number as the format says', () => {
    expect(formatInvoiceNumber('ZD-{YYYY}-{NNNN}', 2026, 1)).toBe('ZD-2026-0001');
    expect(formatInvoiceNumber('ZD-{YYYY}-{NNNN}', 2026, 123)).toBe('ZD-2026-0123');
    expect(formatInvoiceNumber('RE{YY}{NNN}', 2027, 7)).toBe('RE27007');
    expect(formatInvoiceNumber('{N}', 2026, 42)).toBe('42');
    // a number that outgrows its digits is not cut off
    expect(formatInvoiceNumber('ZD-{NN}', 2026, 1234)).toBe('ZD-1234');
  });

  it('needs a running number and only harmless characters', () => {
    expect(isInvoiceNumberFormat('ZD-{YYYY}-{NNNN}')).toBe(true);
    expect(isInvoiceNumberFormat('RE/{YY}/{NNNNN}')).toBe(true);
    expect(isInvoiceNumberFormat('ZD-{YYYY}')).toBe(false);
    expect(isInvoiceNumberFormat('')).toBe(false);
    expect(isInvoiceNumberFormat('ZD {NNNN}')).toBe(false);
    expect(isInvoiceNumberFormat('ZD-{NNNN}-{MM}')).toBe(false);
    expect(isInvoiceNumberFormat(`${'X'.repeat(40)}{N}`)).toBe(false);
  });
});

describe('the seller', () => {
  it('names what is missing before an invoice may be issued', () => {
    expect(sellerMissingFields(SELLER)).toEqual([]);
    expect(sellerMissingFields(EMPTY_SELLER)).toEqual([
      'Firmenname',
      'Straße und Hausnummer',
      'PLZ',
      'Ort',
      'USt-ID oder Steuernummer',
      'E-Mail',
      'IBAN',
    ]);
    // a tax number does instead of a VAT id
    expect(sellerMissingFields({ ...SELLER, vatId: '', taxNumber: '25/123/45678' })).toEqual([]);
    expect(sellerMissingFields({ ...SELLER, iban: '' })).toEqual(['IBAN']);
  });

  it('survives the round trip through the stored row', () => {
    const settings = {
      seller: SELLER,
      numberFormat: 'ZD-{YYYY}-{NNNN}',
      numberStart: 1,
      paymentTermDays: 14,
      autoInvoiceFrom: '2026-12',
      collectAfterDays: 5,
    };
    const row = sellerToRow(settings);
    expect(row.address_line2).toBeNull();
    expect(row.iban).toBe('DE02120300000000202051');
    expect(row.auto_invoice_from).toBe('2026-12');
    expect(row.collect_after_days).toBe(5);
    // before 0048 the column is absent: three days
    const { collect_after_days: _days, ...before0048 } = row;
    expect(sellerFromRow(before0048).collectAfterDays).toBe(3);
    expect(sellerFromRow(row)).toEqual(settings);
    // the monthly run is off unless a valid month is stored (also before 0047)
    expect(sellerFromRow({ ...row, auto_invoice_from: null }).autoInvoiceFrom).toBeNull();
    expect(sellerFromRow({ ...row, auto_invoice_from: 'bald' }).autoInvoiceFrom).toBeNull();
    const { auto_invoice_from: _absent, ...before0047 } = row;
    expect(sellerFromRow(before0047).autoInvoiceFrom).toBeNull();
    // nothing stored yet: empty seller, default format
    expect(sellerFromRow(null).numberFormat).toBe('ZD-{YYYY}-{NNNN}');
    expect(sellerFromRow(null).seller.country).toBe('DE');
  });
});

describe('dates and words', () => {
  it('dates an invoice by the German calendar day', () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Germany
    expect(berlinDate(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(berlinDate(new Date('2026-06-30T21:59:00Z'))).toBe('2026-06-30');
    expect(berlinDate(new Date('2026-06-30T22:00:00Z'))).toBe('2026-07-01');
  });

  it('adds the payment term across month and year ends', () => {
    expect(addDays('2026-11-27', 14)).toBe('2026-12-11');
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
    expect(addDays('2028-02-20', 14)).toBe('2028-03-05'); // leap year
    expect(addDays('2026-11-27', 0)).toBe('2026-11-27');
  });

  it('writes dates, months and amounts the German way', () => {
    expect(formatDateDe('2026-11-27')).toBe('27.11.2026');
    expect(invoicePeriodLabel('2026-11')).toBe('November 2026');
    expect(invoicePeriodLabel('2027-03')).toBe('März 2027');
    expect(invoiceServicePeriod('2026-11')).toBe('01.11.2026 – 30.11.2026');
    expect(invoiceServicePeriod('2028-02')).toBe('01.02.2028 – 29.02.2028');
    expect(formatCentsEur(7238).replace(/\s/g, ' ')).toBe('72,38 €');
    expect(formatCentsEur(-2380).replace(/\s/g, ' ')).toBe('-23,80 €');
  });
});

describe('an invoice as read from the database', () => {
  const ROW = {
    id: '11111111-1111-4111-8111-111111111111',
    org_id: null,
    kind: 'invoice',
    number: 'ZD-2026-0001',
    period: '2026-11',
    issue_date: '2026-12-01',
    due_date: '2026-12-15',
    seller: { legalName: 'Novax Digital GmbH', iban: 'DE02' },
    recipient: {
      legalName: 'Muster GmbH',
      addressLine1: 'Hauptstraße 1',
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
    },
    lines: [{ label: 'WhatsApp (1×)', amountCents: 1500 }],
    tax_mode: 'de_vat',
    tax_percent: '19',
    net_cents: 1500,
    tax_cents: 285,
    gross_cents: 1785,
    cancels_invoice_id: null,
    cancelled_by_invoice_id: null,
    payment_status: 'open',
    paid_at: null,
    paid_via: null,
    paid_note: null,
    pdf_state: 'ready',
    pdf_path: 'x/ZD-2026-0001.pdf',
    mail_state: 'sent',
    mail_to: 'rechnung@example.com',
    mail_sent_at: '2026-12-01T08:00:00Z',
    mail_error: null,
    created_at: '2026-12-01T08:00:00Z',
  };

  it('reads a row from before 0048 as a transfer invoice without a charge', () => {
    const invoice = parseInvoiceRow(ROW)!;
    expect(invoice.paymentMethod).toBe('transfer');
    expect(invoice.collectState).toBe('none');
    expect(invoice.collectOn).toBeNull();
    const collected = parseInvoiceRow({
      ...ROW,
      payment_method: 'sepa_debit',
      payment_label: 'SEPA-Lastschrift •••• 3000',
      collect_on: '2026-12-04',
      collect_state: 'failed',
      collect_error: 'insufficient_funds',
    })!;
    expect(collected).toMatchObject({
      paymentMethod: 'sepa_debit',
      paymentLabel: 'SEPA-Lastschrift •••• 3000',
      collectOn: '2026-12-04',
      collectState: 'failed',
      collectError: 'insufficient_funds',
    });
    expect(collectErrorLabel('insufficient_funds')).toBe('Konto nicht gedeckt');
    expect(collectErrorLabel('something_new')).toBe('something_new');
    expect(collectErrorLabel(null)).toBe('unbekannter Grund');
  });

  it('parses the frozen parts and fills what an older row lacks', () => {
    const invoice = parseInvoiceRow(ROW)!;
    expect(invoice.orgId).toBeNull(); // the organization is gone, the invoice stays
    expect(invoice.taxPercent).toBe(19);
    expect(invoice.seller.legalName).toBe('Novax Digital GmbH');
    expect(invoice.seller.bic).toBe('');
    expect(invoice.recipient.vatId).toBe('');
    expect(invoice.lines).toEqual([{ label: 'WhatsApp (1×)', amountCents: 1500 }]);
    expect(parseInvoiceRow(null)).toBeNull();
    expect(parseInvoiceRow({ ...ROW, lines: 'broken' })).toBeNull();
  });

  it('shows open, overdue, paid, cancelled and the cancellation itself', () => {
    const invoice = parseInvoiceRow(ROW)!;
    expect(invoiceDisplayStatus(invoice, '2026-12-15')).toBe('open'); // due today is not late
    expect(invoiceDisplayStatus(invoice, '2026-12-16')).toBe('overdue');
    expect(invoiceDisplayStatus({ ...invoice, paymentStatus: 'paid' }, '2027-01-01')).toBe('paid');
    // a charge that is planned or running is not "overdue"; a failed one is, once the date passed
    expect(invoiceDisplayStatus({ ...invoice, collectState: 'scheduled' }, '2027-01-01')).toBe('open');
    expect(invoiceDisplayStatus({ ...invoice, collectState: 'processing' }, '2027-01-01')).toBe('open');
    expect(invoiceDisplayStatus({ ...invoice, collectState: 'failed' }, '2027-01-01')).toBe('overdue');
    expect(
      invoiceDisplayStatus({ ...invoice, cancelledByInvoiceId: 'x', paymentStatus: 'void' }, '2027-01-01')
    ).toBe('cancelled');
    expect(
      invoiceDisplayStatus({ ...invoice, kind: 'cancellation', paymentStatus: 'void' }, '2027-01-01')
    ).toBe('cancellation');
  });

  it('names the file and its place in storage', () => {
    const invoice = parseInvoiceRow(ROW)!;
    expect(invoicePdfPath(invoice)).toBe(`${ROW.id}/ZD-2026-0001.pdf`);
    expect(invoiceFileName(invoice)).toBe('Rechnung-ZD-2026-0001.pdf');
    expect(invoiceFileName({ kind: 'cancellation', number: 'RE/26/0002' })).toBe(
      'Stornorechnung-RE_26_0002.pdf'
    );
  });
});
