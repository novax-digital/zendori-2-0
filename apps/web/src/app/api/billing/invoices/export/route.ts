import { NextResponse } from 'next/server';
import {
  berlinDate,
  invoiceCsv,
  invoiceExportBaseName,
  invoiceFileName,
  isInvoiceExportRange,
  ZipWriter,
  type BillingInvoice,
  type SupabaseClient,
} from '@zendori/core';
import { INVOICE_BUCKET, INVOICE_EXPORT_MAX, listInvoicesForExport } from '@/lib/invoices';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/supabase/session';

// Export of the issued invoices for the bookkeeping (Phase 15b), platform admin
// only: `format=csv` is the list — one row per invoice with customer, amounts
// and payment state — and `format=zip` is every PDF plus that list in one
// archive. `month` is the month of the invoice date (`YYYY-MM`) or `all`.
//
// The archive is streamed: PDF after PDF is read from the private bucket and
// passed on, so neither the size of the answer nor the memory grows with the
// number of invoices.

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** PDFs read from the bucket at the same time. */
const PARALLEL_DOWNLOADS = 8;

const notFound = (): NextResponse => new NextResponse('Nicht gefunden', { status: 404 });

function backToList(request: Request, error: string): NextResponse {
  const url = new URL('/admin/invoices', request.url);
  url.searchParams.set('panel', 'export');
  url.searchParams.set('error', error);
  return NextResponse.redirect(url, { status: 303 });
}

async function downloadPdf(admin: SupabaseClient, path: string): Promise<Uint8Array | null> {
  // one more try: a single hiccup must not leave a hole in the archive
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await admin.storage.from(INVOICE_BUCKET).download(path);
    if (!error && data) return new Uint8Array(await data.arrayBuffer());
  }
  return null;
}

/** The archive piece by piece: every PDF, the list, and a note about PDFs that are missing. */
async function* archiveParts(
  admin: SupabaseClient,
  invoices: BillingInvoice[],
  csv: string,
  now: Date
): AsyncGenerator<Uint8Array> {
  const zip = new ZipWriter();
  const used = new Set<string>();
  const missing: string[] = [];

  for (let i = 0; i < invoices.length; i += PARALLEL_DOWNLOADS) {
    const batch = invoices.slice(i, i + PARALLEL_DOWNLOADS);
    const files = await Promise.all(
      batch.map((invoice) =>
        invoice.pdfState === 'ready' && invoice.pdfPath
          ? downloadPdf(admin, invoice.pdfPath)
          : Promise.resolve(null)
      )
    );
    for (const [index, invoice] of batch.entries()) {
      const bytes = files[index];
      if (!bytes) {
        missing.push(invoice.number);
        continue;
      }
      let name = invoiceFileName(invoice);
      for (let n = 2; used.has(name); n += 1) {
        name = invoiceFileName(invoice).replace(/\.pdf$/, `-${n}.pdf`);
      }
      used.add(name);
      yield zip.file(name, bytes, new Date(`${invoice.issueDate}T00:00:00Z`));
    }
  }

  yield zip.file('Rechnungsliste.csv', Buffer.from(csv, 'utf8'), now);
  if (missing.length > 0) {
    const note = [
      'Für diese Rechnungen liegt kein PDF vor (es wird noch erzeugt oder ist fehlgeschlagen).',
      'Sie stehen in der Rechnungsliste, fehlen aber als Datei:',
      '',
      ...missing,
      '',
    ].join('\r\n');
    yield zip.file('Hinweis-fehlende-PDFs.txt', Buffer.from(`﻿${note}`, 'utf8'), now);
  }
  yield zip.end();
}

function streamOf(parts: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await parts.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (err) {
        // a broken download beats an archive that looks complete and is not
        controller.error(err);
      }
    },
    async cancel() {
      await parts.return(undefined);
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return notFound();
  // the caller's own row (RLS): only a platform admin has one
  const supabase = await createSupabaseServerClient();
  const { data: adminRow } = await supabase
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!adminRow) return notFound();

  const params = new URL(request.url).searchParams;
  const format = params.get('format');
  const month = params.get('month') ?? '';
  if ((format !== 'zip' && format !== 'csv') || !isInvoiceExportRange(month)) {
    return backToList(request, 'Bitte Zeitraum und Format wählen.');
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return backToList(request, 'Der Export ist serverseitig nicht konfiguriert.');
  const list = await listInvoicesForExport(admin, month);
  if (!list) return backToList(request, 'Die Rechnungen konnten nicht gelesen werden.');
  if (list.tooMany) {
    return backToList(
      request,
      `Mehr als ${INVOICE_EXPORT_MAX.toLocaleString('de-DE')} Rechnungen — bitte einen einzelnen Monat exportieren.`
    );
  }
  if (list.invoices.length === 0) {
    return backToList(request, 'In diesem Zeitraum gibt es keine Rechnungen.');
  }

  const now = new Date();
  const csv = invoiceCsv(list.invoices, { today: berlinDate(now), numbers: list.numbers });
  const baseName = invoiceExportBaseName(month);
  if (format === 'csv') {
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${baseName}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }
  return new Response(streamOf(archiveParts(admin, list.invoices, csv, now)), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${baseName}.zip"`,
      'cache-control': 'no-store',
    },
  });
}
