// The PDF of an invoice (Phase 15b, migration 0046). Rendered by the worker from
// the FROZEN document in billing_invoices — never from live prices or the
// customer's current details — so the same row always yields the same paper.
//
// Layout: one or more A4 pages in the German business-letter tradition (address
// window on the left, document data on the right), the lines as a table, the
// totals, how to pay, and the seller's legal details in the footer of every page.
//
// pdfkit with its built-in Helvetica (WinAnsi): covers German text and the €
// sign without shipping a font. A later e-invoice (ZUGFeRD) can embed its XML
// through the same library.
import PDFDocument from 'pdfkit';
import {
  formatCentsEur,
  formatDateDe,
  invoicePeriodLabel,
  invoiceServicePeriod,
  type BillingInvoice,
  type InvoiceSeller,
} from '@zendori/core';

export interface InvoicePdfInput {
  invoice: BillingInvoice;
  /** For a cancellation: the number of the invoice it cancels. */
  cancelsNumber?: string | null;
  /** false only in tests (keeps the text readable in the raw file). */
  compress?: boolean;
}

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { left: 62, right: 50, top: 50, bottom: 96 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;
const INK = '#16202a';
const MUTED = '#5b6b7b';
const RULE = '#d5dde5';

const COUNTRY_NAMES: Record<string, string> = {
  AT: 'Österreich',
  BE: 'Belgien',
  BG: 'Bulgarien',
  CY: 'Zypern',
  CZ: 'Tschechien',
  DK: 'Dänemark',
  EE: 'Estland',
  ES: 'Spanien',
  FI: 'Finnland',
  FR: 'Frankreich',
  GR: 'Griechenland',
  HR: 'Kroatien',
  HU: 'Ungarn',
  IE: 'Irland',
  IT: 'Italien',
  LT: 'Litauen',
  LU: 'Luxemburg',
  LV: 'Lettland',
  MT: 'Malta',
  NL: 'Niederlande',
  PL: 'Polen',
  PT: 'Portugal',
  RO: 'Rumänien',
  SE: 'Schweden',
  SI: 'Slowenien',
  SK: 'Slowakei',
};

/** Helvetica/WinAnsi cannot draw everything: keep what it can, replace the rest. */
function printable(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[‐‑]/g, '-')
    .replace(/ | /g, ' ')
    // WinAnsi = Latin-1 plus a handful of typographic signs
    .replace(/[^ -~¡-ÿ€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g, '?');
}

/** The money as it is printed (non-breaking spaces would not render). */
function money(cents: number): string {
  return printable(formatCentsEur(cents));
}

function sellerAddressLine(seller: InvoiceSeller): string {
  return [seller.legalName, seller.addressLine1, `${seller.postalCode} ${seller.city}`.trim()]
    .filter((part) => part !== '')
    .join(' · ');
}

function footerColumns(seller: InvoiceSeller): string[][] {
  const company = [
    seller.legalName,
    seller.addressLine1,
    seller.addressLine2,
    `${seller.postalCode} ${seller.city}`.trim(),
  ];
  const contact = [
    seller.email,
    seller.phone,
    seller.website,
    seller.managingDirectors ? `Geschäftsführung: ${seller.managingDirectors}` : '',
  ];
  const legal = [
    seller.registerCourt && seller.registerNumber
      ? `${seller.registerCourt}, ${seller.registerNumber}`
      : seller.registerNumber || seller.registerCourt,
    seller.vatId ? `USt-ID: ${seller.vatId}` : '',
    seller.taxNumber ? `Steuernummer: ${seller.taxNumber}` : '',
  ];
  const bank = [
    seller.bankName,
    seller.iban ? `IBAN: ${seller.iban}` : '',
    seller.bic ? `BIC: ${seller.bic}` : '',
  ];
  return [company, contact, legal, bank].map((column) =>
    column.filter((line) => line !== '').map(printable)
  );
}

/** Renders the invoice and resolves with the bytes of the PDF. */
export function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const { invoice } = input;
  const cancellation = invoice.kind === 'cancellation';
  const title = cancellation ? 'Stornorechnung' : 'Rechnung';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGIN.top, bottom: MARGIN.bottom, left: MARGIN.left, right: MARGIN.right },
      compress: input.compress ?? true,
      bufferPages: true,
      info: {
        Title: `${title} ${invoice.number}`,
        Author: invoice.seller.legalName,
        Subject: `${title} für ${invoicePeriodLabel(invoice.period)}`,
        // the day of issue, not the moment of rendering: a re-render is the same document
        CreationDate: new Date(`${invoice.issueDate}T00:00:00Z`),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { seller, recipient } = invoice;
    const right = PAGE.width - MARGIN.right;

    // --- seller, top right ---------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK);
    doc.text(printable(seller.legalName), MARGIN.left, MARGIN.top, {
      width: CONTENT_WIDTH,
      align: 'right',
    });
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
    for (const line of [
      seller.addressLine1,
      seller.addressLine2,
      `${seller.postalCode} ${seller.city}`.trim(),
      seller.email,
      seller.website,
    ]) {
      if (line) doc.text(printable(line), { width: CONTENT_WIDTH, align: 'right' });
    }

    // --- address window (DIN 5008, form B: starts 45 mm from the top) ---------
    const windowTop = 127.6;
    doc.font('Helvetica').fontSize(7).fillColor(MUTED);
    doc.text(printable(sellerAddressLine(seller)), MARGIN.left, windowTop, { width: 240 });
    doc.font('Helvetica').fontSize(10.5).fillColor(INK);
    let addressY = windowTop + 16;
    for (const line of [
      recipient.legalName,
      recipient.addressLine1,
      recipient.addressLine2,
      `${recipient.postalCode} ${recipient.city}`.trim(),
      recipient.country !== seller.country ? (COUNTRY_NAMES[recipient.country] ?? recipient.country) : '',
    ]) {
      if (!line) continue;
      doc.text(printable(line), MARGIN.left, addressY, { width: 240 });
      addressY = doc.y;
    }

    // --- document data, right of the address ----------------------------------
    const facts: [string, string][] = [
      [cancellation ? 'Stornorechnung Nr.' : 'Rechnungsnummer', invoice.number],
      ['Rechnungsdatum', formatDateDe(invoice.issueDate)],
      ['Leistungszeitraum', invoiceServicePeriod(invoice.period)],
    ];
    if (cancellation && input.cancelsNumber) facts.push(['Zu Rechnung', input.cancelsNumber]);
    if (!cancellation && invoice.dueDate) facts.push(['Fällig am', formatDateDe(invoice.dueDate)]);
    if (recipient.vatId) facts.push(['USt-ID des Kunden', recipient.vatId]);
    const factsLeft = right - 220;
    let factsY = windowTop + 16;
    doc.fontSize(9);
    for (const [label, value] of facts) {
      doc.font('Helvetica').fillColor(MUTED).text(printable(label), factsLeft, factsY, { width: 100 });
      doc
        .font('Helvetica-Bold')
        .fillColor(INK)
        .text(printable(value), factsLeft + 100, factsY, { width: 120, align: 'right' });
      factsY = Math.max(doc.y, factsY + 13);
    }

    // --- title and intro -------------------------------------------------------
    let y = Math.max(addressY, factsY, 250) + 26;
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK);
    doc.text(printable(`${title} ${invoice.number}`), MARGIN.left, y, { width: CONTENT_WIDTH });
    doc.moveDown(0.6);
    doc.font('Helvetica').fontSize(10).fillColor(INK);
    doc.text(
      printable(
        cancellation
          ? `hiermit stornieren wir die Rechnung ${input.cancelsNumber ?? ''} für ${invoicePeriodLabel(invoice.period)} vollständig. Die Beträge dieser Stornorechnung heben die ursprüngliche Rechnung auf.`
          : `für die Nutzung von Zendori im ${invoicePeriodLabel(invoice.period)} berechnen wir Ihnen:`
      ),
      { width: CONTENT_WIDTH }
    );
    y = doc.y + 16;

    // --- the lines -------------------------------------------------------------
    const colAmount = 90;
    const colQuantity = 120;
    const colLabel = CONTENT_WIDTH - colAmount - colQuantity;
    const drawTableHead = (top: number): number => {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED);
      doc.text('Leistung', MARGIN.left, top, { width: colLabel });
      doc.text('Menge', MARGIN.left + colLabel, top, { width: colQuantity, align: 'right' });
      doc.text('Betrag netto', MARGIN.left + colLabel + colQuantity, top, {
        width: colAmount,
        align: 'right',
      });
      const ruleY = top + 14;
      doc.moveTo(MARGIN.left, ruleY).lineTo(right, ruleY).lineWidth(0.7).strokeColor(RULE).stroke();
      return ruleY + 7;
    };
    y = drawTableHead(y);
    const pageBottom = PAGE.height - MARGIN.bottom;
    doc.font('Helvetica').fontSize(10).fillColor(INK);
    for (const line of invoice.lines) {
      const label = printable(line.label);
      const rowHeight = Math.max(doc.heightOfString(label, { width: colLabel - 8 }), 12) + 8;
      if (y + rowHeight > pageBottom - 20) {
        doc.addPage();
        y = drawTableHead(MARGIN.top);
        doc.font('Helvetica').fontSize(10).fillColor(INK);
      }
      doc.fillColor(INK).text(label, MARGIN.left, y, { width: colLabel - 8 });
      doc
        .fillColor(MUTED)
        .text(printable(line.quantity ?? ''), MARGIN.left + colLabel, y, {
          width: colQuantity,
          align: 'right',
        });
      doc
        .fillColor(INK)
        .text(money(line.amountCents), MARGIN.left + colLabel + colQuantity, y, {
          width: colAmount,
          align: 'right',
        });
      y += rowHeight;
      doc.moveTo(MARGIN.left, y - 4).lineTo(right, y - 4).lineWidth(0.4).strokeColor(RULE).stroke();
    }

    // --- totals (kept together on one page) ---------------------------------------
    if (y + 150 > pageBottom) {
      doc.addPage();
      y = MARGIN.top;
    }
    y += 8;
    const totalsLeft = right - 250;
    const totalRow = (label: string, value: string, bold = false): void => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10);
      doc.fillColor(bold ? INK : MUTED).text(printable(label), totalsLeft, y, { width: 150 });
      doc.fillColor(INK).text(value, totalsLeft + 150, y, { width: 100, align: 'right' });
      y += bold ? 18 : 15;
    };
    totalRow('Summe netto', money(invoice.netCents));
    totalRow(
      invoice.taxMode === 'eu_reverse_charge'
        ? 'Umsatzsteuer (Reverse Charge)'
        : `Umsatzsteuer ${String(invoice.taxPercent).replace('.', ',')} %`,
      money(invoice.taxCents)
    );
    doc.moveTo(totalsLeft, y).lineTo(right, y).lineWidth(0.7).strokeColor(INK).stroke();
    y += 6;
    totalRow(cancellation ? 'Gutschrift gesamt' : 'Rechnungsbetrag', money(invoice.grossCents), true);

    // --- notes ---------------------------------------------------------------------
    y += 14;
    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
    const note = (text: string): void => {
      doc.text(printable(text), MARGIN.left, y, { width: CONTENT_WIDTH });
      y = doc.y + 8;
    };
    if (invoice.taxMode === 'eu_reverse_charge') {
      note(
        'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge, Art. 196 MwStSystRL). Die Umsatzsteuer schuldet der Leistungsempfänger.'
      );
    }
    if (cancellation) {
      note(
        'Ein bereits gezahlter Betrag wird erstattet oder mit der nächsten Rechnung verrechnet.'
      );
    } else if (invoice.grossCents > 0) {
      const bank = [
        seller.bankName,
        seller.iban ? `IBAN ${seller.iban}` : '',
        seller.bic ? `BIC ${seller.bic}` : '',
      ]
        .filter((part) => part !== '')
        .join(', ');
      note(
        `Bitte überweisen Sie den Rechnungsbetrag${invoice.dueDate ? ` bis zum ${formatDateDe(invoice.dueDate)}` : ''} unter Angabe der Rechnungsnummer ${invoice.number} auf folgendes Konto: ${bank}.`
      );
    }
    if (seller.footerNote) note(seller.footerNote);

    // --- footer on every page --------------------------------------------------------
    const columns = footerColumns(seller);
    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      doc.switchToPage(range.start + index);
      // the footer sits IN the bottom margin: without this pdfkit would open a
      // new page for every line written there
      doc.page.margins.bottom = 0;
      const top = PAGE.height - MARGIN.bottom + 22;
      doc
        .moveTo(MARGIN.left, top - 8)
        .lineTo(right, top - 8)
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke();
      doc.font('Helvetica').fontSize(7).fillColor(MUTED);
      // company · contact · register and tax · bank (an IBAN needs the widest column)
      const shares = [0.19, 0.27, 0.26, 0.28];
      let columnLeft = MARGIN.left;
      columns.forEach((column, columnIndex) => {
        const columnWidth = CONTENT_WIDTH * (shares[columnIndex] ?? 0.25);
        doc.text(column.join('\n'), columnLeft, top, {
          width: columnWidth - 8,
          height: MARGIN.bottom - 30,
        });
        columnLeft += columnWidth;
      });
      if (range.count > 1) {
        doc.text(`Seite ${index + 1} von ${range.count}`, MARGIN.left, PAGE.height - 30, {
          width: CONTENT_WIDTH,
          align: 'right',
          lineBreak: false,
        });
      }
    }

    doc.end();
  });
}
