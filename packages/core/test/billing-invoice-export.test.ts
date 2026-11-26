import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { EMPTY_SELLER, type BillingInvoice } from '../src/billing-invoice.js';
import {
  INVOICE_CSV_HEADERS,
  centsToCsvAmount,
  csvText,
  invoiceCsv,
  invoiceExportBaseName,
  isInvoiceExportRange,
} from '../src/billing-invoice-export.js';
import {
  INVOICE_EXPORT_MAX,
  invoiceExportMonths,
  listInvoicesForExport,
} from '../src/billing-invoices.js';
import { ZipWriter } from '../src/zip.js';
import { createMemoryDb } from './memory-supabase.js';

// Export for the bookkeeping: the CSV list of invoices and the archive of PDFs.

function invoice(patch: Partial<BillingInvoice> = {}): BillingInvoice {
  return {
    id: 'inv-1',
    orgId: 'org-1',
    kind: 'invoice',
    number: 'ZD-2026-1010',
    period: '2026-10',
    issueDate: '2026-11-01',
    dueDate: '2026-11-15',
    seller: { ...EMPTY_SELLER, legalName: 'Novax Digital GmbH' },
    recipient: {
      legalName: 'Strong Energy GmbH',
      addressLine1: 'Hauptstr. 1',
      addressLine2: '',
      postalCode: '30159',
      city: 'Hannover',
      country: 'DE',
      vatId: 'DE123456789',
      billingEmail: 'buchhaltung@example.com',
    },
    lines: [{ label: 'Grundgebühr', amountCents: 10000 }],
    taxMode: 'de_vat',
    taxPercent: 19,
    netCents: 10000,
    taxCents: 1900,
    grossCents: 11900,
    cancelsInvoiceId: null,
    cancelledByInvoiceId: null,
    paymentStatus: 'open',
    paidAt: null,
    paidVia: null,
    paidNote: null,
    paymentMethod: 'transfer',
    paymentLabel: null,
    collectOn: null,
    collectState: 'none',
    collectError: null,
    collectedAt: null,
    pdfState: 'ready',
    pdfPath: 'inv-1/ZD-2026-1010.pdf',
    mailState: 'sent',
    mailTo: 'buchhaltung@example.com',
    mailSentAt: '2026-11-01T08:00:00Z',
    mailError: null,
    createdAt: '2026-11-01T07:00:00Z',
    ...patch,
  };
}

/** Splits the CSV into rows of cells (no cell in these tests holds a line break). */
function cells(csv: string): string[][] {
  return csv
    .replace(/^﻿/, '')
    .trimEnd()
    .split('\r\n')
    .map((line) => line.split(';'));
}

const column = (name: (typeof INVOICE_CSV_HEADERS)[number]): number =>
  INVOICE_CSV_HEADERS.indexOf(name);

describe('invoice CSV', () => {
  it('is made for German Excel: byte order mark, semicolons, CRLF, one row per invoice', () => {
    const csv = invoiceCsv([invoice()], { today: '2026-11-10' });
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    const rows = cells(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([...INVOICE_CSV_HEADERS]);
    expect(rows[1]).toHaveLength(INVOICE_CSV_HEADERS.length);
  });

  it('carries the customer, the amounts and the dates of the frozen invoice', () => {
    const row = cells(invoiceCsv([invoice()], { today: '2026-11-10' }))[1]!;
    expect(row[column('Rechnungsnummer')]).toBe('ZD-2026-1010');
    expect(row[column('Art')]).toBe('Rechnung');
    expect(row[column('Rechnungsdatum')]).toBe('01.11.2026');
    expect(row[column('Leistung von')]).toBe('01.10.2026');
    expect(row[column('Leistung bis')]).toBe('31.10.2026');
    expect(row[column('Fällig am')]).toBe('15.11.2026');
    expect(row[column('Kunde')]).toBe('Strong Energy GmbH');
    expect(row[column('PLZ')]).toBe('30159');
    expect(row[column('USt-ID')]).toBe('DE123456789');
    expect(row[column('Rechnungs-E-Mail')]).toBe('buchhaltung@example.com');
    expect(row[column('Netto (EUR)')]).toBe('100,00');
    expect(row[column('Steuersatz (%)')]).toBe('19');
    expect(row[column('Steuer (EUR)')]).toBe('19,00');
    expect(row[column('Brutto (EUR)')]).toBe('119,00');
    expect(row[column('Steuerart')]).toBe('Umsatzsteuer');
    expect(row[column('Status')]).toBe('Offen');
    expect(row[column('Zahlungsart')]).toBe('Überweisung');
    expect(row[column('Kunden-ID')]).toBe('org-1');
  });

  it('says overdue, paid and how it was paid', () => {
    const overdue = cells(invoiceCsv([invoice()], { today: '2026-11-16' }))[1]!;
    expect(overdue[column('Status')]).toBe('Überfällig');

    const paid = cells(
      invoiceCsv(
        [
          invoice({
            paymentStatus: 'paid',
            // 23:30 UTC is already the next day in Germany
            paidAt: '2026-11-04T23:30:00Z',
            paidVia: 'stripe',
            paymentMethod: 'sepa_debit',
            collectOn: '2026-11-04',
            collectState: 'succeeded',
          }),
        ],
        { today: '2026-11-16' }
      )
    )[1]!;
    expect(paid[column('Status')]).toBe('Bezahlt');
    expect(paid[column('Bezahlt am')]).toBe('05.11.2026');
    expect(paid[column('Bezahlt über')]).toBe('Stripe');
    expect(paid[column('Zahlungsart')]).toBe('SEPA-Lastschrift');
    expect(paid[column('Einzug ab')]).toBe('04.11.2026');
    expect(paid[column('Einzug')]).toBe('eingezogen');
  });

  it('lists a cancellation with negative amounts and names both documents', () => {
    const original = invoice({ cancelledByInvoiceId: 'inv-2', paymentStatus: 'void' });
    const cancellation = invoice({
      id: 'inv-2',
      kind: 'cancellation',
      number: 'ZD-2026-1011',
      issueDate: '2026-11-05',
      dueDate: null,
      netCents: -10000,
      taxCents: -1900,
      grossCents: -11900,
      cancelsInvoiceId: 'inv-1',
    });
    const rows = cells(invoiceCsv([original, cancellation], { today: '2026-11-10' }));
    expect(rows[1]![column('Status')]).toBe('Storniert');
    expect(rows[1]![column('Storniert durch')]).toBe('ZD-2026-1011');
    expect(rows[2]![column('Art')]).toBe('Stornorechnung');
    expect(rows[2]![column('Brutto (EUR)')]).toBe('-119,00');
    expect(rows[2]![column('Netto (EUR)')]).toBe('-100,00');
    expect(rows[2]![column('Storno zu Rechnung')]).toBe('ZD-2026-1010');
    expect(rows[2]![column('Fällig am')]).toBe('');
    expect(rows[2]![column('Zahlungsart')]).toBe('');
  });

  it('names an invoice outside the export through the numbers handed in', () => {
    const cancellation = invoice({
      id: 'inv-2',
      kind: 'cancellation',
      number: 'ZD-2026-1011',
      cancelsInvoiceId: 'inv-1',
    });
    const row = cells(
      invoiceCsv([cancellation], {
        today: '2026-11-10',
        numbers: new Map([['inv-1', 'ZD-2026-1010']]),
      })
    )[1]!;
    expect(row[column('Storno zu Rechnung')]).toBe('ZD-2026-1010');
  });

  it('reverse charge and an invoice whose organization is gone', () => {
    const row = cells(
      invoiceCsv(
        [invoice({ orgId: null, taxMode: 'eu_reverse_charge', taxPercent: 0, taxCents: 0, grossCents: 10000 })],
        { today: '2026-11-10' }
      )
    )[1]!;
    expect(row[column('Steuerart')]).toBe('Reverse Charge');
    expect(row[column('Steuersatz (%)')]).toBe('0');
    expect(row[column('Brutto (EUR)')]).toBe('100,00');
    expect(row[column('Kunden-ID')]).toBe('');
  });

  it('never lets a company name run as a formula or break the columns', () => {
    const csv = invoiceCsv(
      [
        invoice({
          recipient: {
            ...invoice().recipient,
            legalName: '=HYPERLINK("http://example.com";"Klick")',
            addressLine1: 'Am Markt 3; Hinterhaus',
            city: '@Hannover',
          },
          paidNote: '+49 511 000',
        }),
      ],
      { today: '2026-11-10' }
    );
    expect(csv).toContain(`"'=HYPERLINK(""http://example.com"";""Klick"")"`);
    expect(csv).toContain('"Am Markt 3; Hinterhaus"');
    expect(csv).toContain(";'@Hannover;");
    expect(csv).toContain(";'+49 511 000;");
  });
});

describe('CSV cells', () => {
  it('writes amounts with a decimal comma and without a currency sign', () => {
    expect(centsToCsvAmount(0)).toBe('0,00');
    expect(centsToCsvAmount(5)).toBe('0,05');
    expect(centsToCsvAmount(123456)).toBe('1234,56');
    expect(centsToCsvAmount(-11900)).toBe('-119,00');
    expect(centsToCsvAmount(-5)).toBe('-0,05');
  });

  it('quotes only where needed', () => {
    expect(csvText('Novax Digital GmbH')).toBe('Novax Digital GmbH');
    expect(csvText(null)).toBe('');
    expect(csvText('a "b" c')).toBe('"a ""b"" c"');
    expect(csvText('Zeile 1\r\nZeile 2')).toBe('"Zeile 1\nZeile 2"');
    expect(csvText('-5 Grad GmbH')).toBe("'-5 Grad GmbH");
  });

  it('knows the ranges that can be exported', () => {
    expect(isInvoiceExportRange('all')).toBe(true);
    expect(isInvoiceExportRange('2026-11')).toBe(true);
    expect(isInvoiceExportRange('2026-13')).toBe(false);
    expect(isInvoiceExportRange('2026-11-01')).toBe(false);
    expect(isInvoiceExportRange('')).toBe(false);
    expect(invoiceExportBaseName('all')).toBe('Rechnungen-gesamt');
    expect(invoiceExportBaseName('2026-11')).toBe('Rechnungen-2026-11');
  });
});

// A reader that follows the format from the back, the way an unpacker does:
// end record → table of contents → each file's own header and bytes.
function readZip(archive: Buffer): { name: string; data: Buffer; modified: Date }[] {
  const end = archive.length - 22;
  expect(archive.readUInt32LE(end)).toBe(0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  expect(archive.readUInt16LE(end + 8)).toBe(count);
  const directorySize = archive.readUInt32LE(end + 12);
  const directoryStart = archive.readUInt32LE(end + 16);
  expect(directoryStart + directorySize).toBe(end);

  const files: { name: string; data: Buffer; modified: Date }[] = [];
  let at = directoryStart;
  for (let i = 0; i < count; i += 1) {
    expect(archive.readUInt32LE(at)).toBe(0x02014b50);
    expect(archive.readUInt16LE(at + 8) & 0x0800).toBe(0x0800); // UTF-8 names
    expect(archive.readUInt16LE(at + 10)).toBe(0); // stored
    const time = archive.readUInt16LE(at + 12);
    const date = archive.readUInt16LE(at + 14);
    const crc = archive.readUInt32LE(at + 16);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const offset = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength;

    // the file's own header must say the same
    expect(archive.readUInt32LE(offset)).toBe(0x04034b50);
    expect(archive.readUInt32LE(offset + 14)).toBe(crc);
    expect(archive.readUInt32LE(offset + 18)).toBe(size);
    expect(archive.readUInt32LE(offset + 22)).toBe(size);
    const localNameLength = archive.readUInt16LE(offset + 26);
    expect(archive.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8')).toBe(name);
    const data = archive.subarray(offset + 30 + localNameLength, offset + 30 + localNameLength + size);
    expect(crc32(data)).toBe(crc);
    files.push({
      name,
      data: Buffer.from(data),
      modified: new Date(
        Date.UTC(
          (date >> 9) + 1980,
          ((date >> 5) & 0x0f) - 1,
          date & 0x1f,
          time >> 11,
          (time >> 5) & 0x3f,
          (time & 0x1f) * 2
        )
      ),
    });
  }
  expect(at).toBe(end);
  return files;
}

describe('ZipWriter', () => {
  it('writes an archive whose parts can be sent one by one', () => {
    const zip = new ZipWriter();
    const pdf = Buffer.from('%PDF-1.3 not really a pdf');
    const list = Buffer.from('﻿Rechnungsnummer;Kunde\r\nZD-1;Müller & Söhne\r\n', 'utf8');
    const parts = [
      zip.file('Rechnung-ZD-2026-1010.pdf', pdf, new Date('2026-11-01T00:00:00Z')),
      zip.file('Rechnungsliste-März.csv', list, new Date('2026-11-27T13:45:10Z')),
      zip.file('leer.txt', new Uint8Array(0), new Date('2026-11-27T13:45:10Z')),
    ];
    const files = readZip(Buffer.concat([...parts, zip.end()]));
    expect(files.map((file) => file.name)).toEqual([
      'Rechnung-ZD-2026-1010.pdf',
      'Rechnungsliste-März.csv',
      'leer.txt',
    ]);
    expect(files[0]!.data.equals(pdf)).toBe(true);
    expect(files[1]!.data.equals(list)).toBe(true);
    expect(files[2]!.data).toHaveLength(0);
    expect(files[0]!.modified.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(files[1]!.modified.toISOString()).toBe('2026-11-27T13:45:10.000Z');
  });

  it('an archive without files is still an archive', () => {
    expect(readZip(Buffer.from(new ZipWriter().end()))).toEqual([]);
  });

  it('refuses names that would leave the folder, doubles, and writing after the end', () => {
    const zip = new ZipWriter();
    const data = Buffer.from('x');
    const now = new Date('2026-11-27T00:00:00Z');
    for (const name of ['', '/etc/passwd', '../oben.pdf', 'a/../b.pdf', 'a\\b.pdf', 'a//b.pdf']) {
      expect(() => zip.file(name, data, now)).toThrow('unsafe file name');
    }
    zip.file('a.pdf', data, now);
    expect(() => zip.file('a.pdf', data, now)).toThrow('duplicate file name');
    zip.end();
    expect(() => zip.file('b.pdf', data, now)).toThrow('already finished');
    expect(() => zip.end()).toThrow('already finished');
  });
});

// --- reading the invoices of a range ----------------------------------------------

function invoiceRow(index: number, issueDate: string, patch: Record<string, unknown> = {}) {
  return {
    id: `inv-${String(index).padStart(5, '0')}`,
    org_id: 'org-1',
    kind: 'invoice',
    number: `ZD-${index}`,
    period: '2026-10',
    issue_date: issueDate,
    due_date: null,
    seller: { legalName: 'Novax Digital GmbH' },
    recipient: {
      legalName: 'Strong Energy GmbH',
      addressLine1: 'Hauptstr. 1',
      postalCode: '30159',
      city: 'Hannover',
      country: 'DE',
    },
    lines: [{ label: 'Grundgebühr', amountCents: 10000 }],
    tax_mode: 'de_vat',
    tax_percent: 19,
    net_cents: 10000,
    tax_cents: 1900,
    gross_cents: 11900,
    cancels_invoice_id: null,
    cancelled_by_invoice_id: null,
    payment_status: 'open',
    pdf_state: 'ready',
    mail_state: 'none',
    // creation order = number order
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    ...patch,
  };
}

describe('invoices of an export range', () => {
  it('takes a month by invoice date, oldest first', async () => {
    const db = createMemoryDb({
      billing_invoices: [
        invoiceRow(3, '2026-12-01'),
        invoiceRow(2, '2026-11-30'),
        invoiceRow(1, '2026-11-01'),
        invoiceRow(0, '2026-10-31'),
      ],
    });
    const november = await listInvoicesForExport(db.client, '2026-11');
    expect(november?.invoices.map((invoice) => invoice.number)).toEqual(['ZD-1', 'ZD-2']);
    expect(november?.tooMany).toBe(false);

    const december = await listInvoicesForExport(db.client, '2026-12');
    expect(december?.invoices.map((invoice) => invoice.number)).toEqual(['ZD-3']);

    const all = await listInvoicesForExport(db.client, 'all');
    expect(all?.invoices.map((invoice) => invoice.number)).toEqual(['ZD-0', 'ZD-1', 'ZD-2', 'ZD-3']);

    expect(await listInvoicesForExport(db.client, '2026-13')).toBeNull();
  });

  it('reads past one page and misses nothing', async () => {
    const rows = Array.from({ length: 1203 }, (_, index) => invoiceRow(index, '2026-11-15'));
    const db = createMemoryDb({ billing_invoices: rows });
    const list = await listInvoicesForExport(db.client, '2026-11');
    expect(list?.invoices).toHaveLength(1203);
    expect(new Set(list?.invoices.map((invoice) => invoice.id)).size).toBe(1203);
    expect(list?.invoices[0]?.number).toBe('ZD-0');
    expect(list?.invoices[1202]?.number).toBe('ZD-1202');
    expect(list?.tooMany).toBe(false);
  });

  it('says so when there are more than one export takes', async () => {
    const rows = Array.from({ length: INVOICE_EXPORT_MAX + 1 }, (_, index) =>
      invoiceRow(index, '2026-11-15')
    );
    const db = createMemoryDb({ billing_invoices: rows });
    const list = await listInvoicesForExport(db.client, 'all');
    expect(list?.tooMany).toBe(true);
  });

  it('exactly the maximum is still a complete export', async () => {
    const rows = Array.from({ length: INVOICE_EXPORT_MAX }, (_, index) =>
      invoiceRow(index, '2026-11-15')
    );
    const db = createMemoryDb({ billing_invoices: rows });
    const list = await listInvoicesForExport(db.client, 'all');
    expect(list?.tooMany).toBe(false);
    expect(list?.invoices).toHaveLength(INVOICE_EXPORT_MAX);
  });

  it('looks up the number of an invoice that is cancelled in another month', async () => {
    const db = createMemoryDb({
      billing_invoices: [
        invoiceRow(1, '2026-11-01', { cancelled_by_invoice_id: 'inv-00002' }),
        invoiceRow(2, '2026-12-03', { kind: 'cancellation', cancels_invoice_id: 'inv-00001' }),
      ],
    });
    const december = await listInvoicesForExport(db.client, '2026-12');
    expect(december?.invoices.map((invoice) => invoice.number)).toEqual(['ZD-2']);
    expect(december?.numbers.get('inv-00001')).toBe('ZD-1');
    const csv = invoiceCsv(december!.invoices, { today: '2026-12-10', numbers: december!.numbers });
    expect(csv).toContain(';ZD-1;');
  });

  it('offers the months from the first invoice date up to today', async () => {
    const db = createMemoryDb({
      billing_invoices: [invoiceRow(1, '2026-11-01'), invoiceRow(0, '2026-09-30')],
    });
    const months = await invoiceExportMonths(db.client, new Date('2026-12-05T10:00:00Z'));
    expect(months.map((month) => month.key)).toEqual(['2026-12', '2026-11', '2026-10', '2026-09']);
    expect(months[0]?.label).toBe('Dezember 2026');

    expect(await invoiceExportMonths(createMemoryDb().client, new Date())).toEqual([]);
  });
});
