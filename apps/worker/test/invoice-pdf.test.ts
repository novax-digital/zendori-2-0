import { describe, expect, it } from 'vitest';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { EMPTY_SELLER, type BillingInvoice } from '@zendori/core';
import { renderInvoicePdf } from '../src/billing/invoice-pdf.js';

// Phase 15b: the PDF of an invoice. Pins that everything § 14 UStG asks for is
// on the paper, that a cancellation reads as one, and that a long invoice
// breaks over pages with the footer on each.

export const SAMPLE_INVOICE: BillingInvoice = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  kind: 'invoice',
  number: 'ZD-2026-0001',
  period: '2026-11',
  issueDate: '2026-12-01',
  dueDate: '2026-12-15',
  seller: {
    ...EMPTY_SELLER,
    legalName: 'Novax Digital GmbH',
    addressLine1: 'Schierholzstr. 27',
    postalCode: '30655',
    city: 'Hannover',
    vatId: 'DE335613731',
    registerCourt: 'Amtsgericht Hannover',
    registerNumber: 'HRB 220589',
    managingDirectors: 'Philipp Polley, Christoph Pfad',
    email: 'info@zendori.ai',
    website: 'zendori.ai',
    bankName: 'Musterbank',
    iban: 'DE02 1203 0000 0000 2020 51',
    bic: 'BYLADEM1001',
  },
  recipient: {
    legalName: 'Müller & Söhne Gebäudetechnik GmbH',
    addressLine1: 'Hauptstraße 12',
    addressLine2: '',
    postalCode: '10115',
    city: 'Berlin',
    country: 'DE',
    vatId: 'DE123456789',
    billingEmail: 'rechnung@example.com',
  },
  lines: [
    { label: 'WhatsApp (1×)', amountCents: 1500 },
    { label: 'Rufnummer Mobil (1×)', amountCents: 3000 },
    { label: 'Telefonie', quantity: '31,5 Minuten', amountCents: 1575 },
    { label: 'KI-Antworten & Klassifikation', quantity: '7 Vorgänge', amountCents: 7 },
  ],
  taxMode: 'de_vat',
  taxPercent: 19,
  netCents: 6082,
  taxCents: 1156,
  grossCents: 7238,
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
  pdfState: 'pending',
  pdfPath: null,
  mailState: 'pending',
  mailTo: 'rechnung@example.com',
  mailSentAt: null,
  mailError: null,
  createdAt: '2026-12-01T08:00:00Z',
};

async function textOf(pdf: Buffer): Promise<{ text: string; pages: number }> {
  // Handed over as a plain Uint8Array, not as the Buffer: pdf.js 1.10 (inside
  // pdf-parse) copies a Buffer with `new Buffer(…)` and then reads sub-streams
  // from the START of the memory block that copy lives in (makeSubStream uses
  // `bytes.buffer` without the offset). A copy below 4 KB comes out of Node's
  // shared pool, so whether this 3 KB invoice parsed depended on what else had
  // been allocated — "bad XRef entry" in CI (2026-11-27), never locally. A
  // plain Uint8Array is copied into memory of its own, starting at byte 0.
  const parsed = await pdfParse(new Uint8Array(pdf));
  return { text: parsed.text.replace(/\s+/g, ' '), pages: parsed.numpages };
}

describe('renderInvoicePdf', () => {
  it('puts everything an invoice needs on the page', async () => {
    const pdf = await renderInvoicePdf({ invoice: SAMPLE_INVOICE });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const { text, pages } = await textOf(pdf);
    expect(pages).toBe(1);
    for (const expected of [
      'Rechnung ZD-2026-0001',
      'Novax Digital GmbH',
      'Schierholzstr. 27',
      'Müller & Söhne Gebäudetechnik GmbH',
      'Hauptstraße 12',
      '10115 Berlin',
      'Rechnungsdatum',
      '01.12.2026',
      'Leistungszeitraum',
      '01.11.2026 – 30.11.2026',
      'USt-ID des Kunden',
      'DE123456789',
      'WhatsApp (1×)',
      '31,5 Minuten',
      'KI-Antworten & Klassifikation',
      '60,82 €',
      'Umsatzsteuer 19 %',
      '11,56 €',
      'Rechnungsbetrag',
      '72,38 €',
      'bis zum 15.12.2026',
      'IBAN DE02 1203 0000 0000 2020 51',
      'USt-ID: DE335613731',
      'Amtsgericht Hannover, HRB 220589',
      'Geschäftsführung: Philipp Polley, Christoph Pfad',
    ]) {
      expect(text, expected).toContain(expected);
    }
    // a German customer: no country line, no reverse-charge note
    expect(text).not.toContain('Reverse Charge');
    expect(text).not.toContain('Deutschland');
  });

  it('is the same document every time it is rendered', async () => {
    const first = await renderInvoicePdf({ invoice: SAMPLE_INVOICE });
    const second = await renderInvoicePdf({ invoice: SAMPLE_INVOICE });
    expect((await textOf(first)).text).toBe((await textOf(second)).text);
    expect(first.toString('latin1')).toContain('D:20261201');
  });

  it('reverse charge: no tax, the note and the country of the customer', async () => {
    const pdf = await renderInvoicePdf({
      invoice: {
        ...SAMPLE_INVOICE,
        recipient: {
          ...SAMPLE_INVOICE.recipient,
          legalName: 'Alpen Handels GmbH',
          city: 'Wien',
          postalCode: '1010',
          country: 'AT',
          vatId: 'ATU12345678',
        },
        taxMode: 'eu_reverse_charge',
        taxPercent: 0,
        taxCents: 0,
        grossCents: 6082,
      },
    });
    const { text } = await textOf(pdf);
    expect(text).toContain('Österreich');
    expect(text).toContain('Umsatzsteuer (Reverse Charge)');
    expect(text).toContain('Steuerschuldnerschaft des Leistungsempfängers');
    expect(text).toContain('ATU12345678');
    expect(text).not.toContain('Umsatzsteuer 19 %');
  });

  it('a cancellation says what it cancels and asks for no payment', async () => {
    const pdf = await renderInvoicePdf({
      invoice: {
        ...SAMPLE_INVOICE,
        kind: 'cancellation',
        number: 'ZD-2026-0002',
        dueDate: null,
        lines: SAMPLE_INVOICE.lines.map((line) => ({ ...line, amountCents: -line.amountCents })),
        netCents: -6082,
        taxCents: -1156,
        grossCents: -7238,
        paymentStatus: 'void',
      },
      cancelsNumber: 'ZD-2026-0001',
    });
    const { text } = await textOf(pdf);
    expect(text).toContain('Stornorechnung ZD-2026-0002');
    expect(text).toContain('Zu Rechnung');
    expect(text).toContain('stornieren wir die Rechnung ZD-2026-0001');
    expect(text).toContain('-72,38 €');
    expect(text).toContain('Gutschrift gesamt');
    expect(text).not.toContain('Bitte überweisen');
    expect(text).not.toContain('Fällig am');
  });

  it('breaks a long invoice over pages and numbers them', async () => {
    const lines = Array.from({ length: 70 }, (_, index) => ({
      label: `Position ${index + 1}`,
      quantity: `${index + 1} Stück`,
      amountCents: 100,
    }));
    const pdf = await renderInvoicePdf({
      invoice: { ...SAMPLE_INVOICE, lines, netCents: 7000, taxCents: 1330, grossCents: 8330 },
    });
    const { text, pages } = await textOf(pdf);
    expect(pages).toBeGreaterThan(1);
    expect(text).toContain('Position 70');
    expect(text).toContain(`Seite 1 von ${pages}`);
    expect(text).toContain(`Seite ${pages} von ${pages}`);
    expect(text).toContain('83,30 €');
  });

  it('draws what Helvetica cannot as a question mark instead of failing', async () => {
    const pdf = await renderInvoicePdf({
      invoice: {
        ...SAMPLE_INVOICE,
        recipient: { ...SAMPLE_INVOICE.recipient, legalName: 'Łódź Sp. z o.o. → 東京' },
      },
    });
    expect((await textOf(pdf)).text).toContain('?ód? Sp. z o.o. ? ??');
  });
});
