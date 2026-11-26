// The paper side of an issued invoice (Phase 15b, migration 0046): render the
// PDF from the frozen row, keep it in the private `invoices` bucket, and mail it
// to the customer's billing address. The app issues the invoice (number and
// content, one transaction) and leaves `pdf_state = 'pending'`; this module
// does the rest. Nothing here can change what the invoice says.
//
// Two steps, each with its own outcome in the row:
//   pdf_state   pending → ready | failed
//   mail_state  pending → sent  | failed      (none = nothing asked for)
// A step that fails is tried again on the schedule below; after the last try it
// is marked failed and shown to the operator, who can ask again. The retry time
// lives in the row (next_attempt_at) — a job never needs a pg-boss retry.
//
// Never logs addresses or amounts (§7).
import {
  BILLING_INVOICE_COLUMNS,
  INVOICE_BUCKET,
  formatCentsEur,
  formatDateDe,
  invoiceFileName,
  invoicePdfPath,
  invoicePeriodLabel,
  isMissingRelationError,
  parseInvoiceRow,
  type BillingInvoice,
  type Logger,
  type SupabaseClient,
} from '@zendori/core';
import {
  isSuppressedEmailRecipient,
  renderInvoiceEmail,
  sendEmail,
  type SendEmailParams,
} from '@zendori/channels';
import { toErrorInfo } from '../db.js';
import { renderInvoicePdf } from './invoice-pdf.js';

export const INVOICE_DOCUMENT_QUEUE = 'billing.invoice-document';
/** Retries are scheduled in the row — the job itself never retries. */
export const INVOICE_DOCUMENT_RETRY_LIMIT = 0;
/** While a try runs, the row is invisible to the scan for this long. */
export const INVOICE_DOCUMENT_LEASE_MS = 5 * 60_000;
/** Wait before the 2nd, 3rd, … try of a step; after the last one it is failed. */
export const INVOICE_DOCUMENT_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
];
const DEFAULT_APP_URL = 'https://app.zendori.ai';

export interface InvoiceDocumentJob {
  invoiceId: string;
}

export interface InvoiceDocumentDeps {
  supabase: SupabaseClient;
  logger: Logger;
  /** Sender address (RESEND_FROM). */
  from: string | undefined;
  /** Public app URL for the link (APP_URL). */
  appUrl: string | undefined;
  /** Injectable for tests. */
  send?: (params: SendEmailParams) => Promise<unknown>;
  render?: typeof renderInvoicePdf;
  now?: () => number;
}

interface WorkRow extends Record<string, unknown> {
  pdf_attempts: number;
  mail_attempts: number;
  next_attempt_at: string | null;
}

/** Is there work on this invoice that is due at `nowMs`? (Also used by the scan.) */
export function isInvoiceDocumentDue(
  row: { pdf_state: string; mail_state: string; next_attempt_at: string | null },
  nowMs: number
): boolean {
  if (row.pdf_state !== 'pending' && row.mail_state !== 'pending') return false;
  // a mail waits for its PDF; a PDF that failed for good blocks it
  if (row.pdf_state === 'failed') return false;
  if (!row.next_attempt_at) return true;
  return Date.parse(row.next_attempt_at) <= nowMs;
}

async function update(
  supabase: SupabaseClient,
  id: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from('billing_invoices').update(patch).eq('id', id);
  if (error) throw error;
}

/** Writes the outcome of a failed step: another try on the schedule, or failed for good. */
async function recordFailure(
  deps: InvoiceDocumentDeps,
  invoice: BillingInvoice,
  step: 'pdf' | 'mail',
  attemptsBefore: number,
  err: unknown
): Promise<void> {
  // a fixed word in the row (shown to the operator); the detail goes to the log
  const error = step === 'pdf' ? 'pdf_failed' : 'send_failed';
  const nowMs = (deps.now ?? Date.now)();
  const attempts = attemptsBefore + 1;
  const delay = INVOICE_DOCUMENT_RETRY_DELAYS_MS[attempts - 1];
  const giveUp = delay === undefined;
  await update(deps.supabase, invoice.id, {
    [`${step}_attempts`]: attempts,
    [`${step}_error`]: error,
    ...(giveUp ? { [`${step}_state`]: 'failed' } : {}),
    next_attempt_at: giveUp ? null : new Date(nowMs + delay).toISOString(),
  });
  deps.logger.warn(
    {
      invoiceId: invoice.id,
      step,
      attempts,
      outcome: giveUp ? 'gave_up' : 'retry',
      err: toErrorInfo(err),
    },
    'invoice document step failed'
  );
}

/**
 * One attempt to finish the paper side of an invoice. A no-op when nothing is
 * pending or the next try is not due yet.
 */
export async function processInvoiceDocument(
  deps: InvoiceDocumentDeps,
  invoiceId: string
): Promise<void> {
  const { supabase, logger } = deps;
  const nowMs = (deps.now ?? Date.now)();

  const { data, error } = await supabase
    .from('billing_invoices')
    .select(`${BILLING_INVOICE_COLUMNS}, pdf_attempts, mail_attempts, next_attempt_at`)
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) {
    if (isMissingRelationError(error)) return;
    throw error;
  }
  const row = data as WorkRow | null;
  const invoice = parseInvoiceRow(row);
  if (!row || !invoice) return;
  if (
    !isInvoiceDocumentDue(
      { pdf_state: invoice.pdfState, mail_state: invoice.mailState, next_attempt_at: row.next_attempt_at },
      nowMs
    )
  ) {
    return;
  }

  // Lease: an attempt that dies is offered again after the lease.
  await update(supabase, invoice.id, {
    next_attempt_at: new Date(nowMs + INVOICE_DOCUMENT_LEASE_MS).toISOString(),
  });

  // For a cancellation the paper names the invoice it cancels.
  let cancelsNumber: string | null = null;
  if (invoice.cancelsInvoiceId) {
    const { data: original } = await supabase
      .from('billing_invoices')
      .select('number')
      .eq('id', invoice.cancelsInvoiceId)
      .maybeSingle();
    cancelsNumber = (original as { number: string } | null)?.number ?? null;
  }

  // --- 1. the PDF ----------------------------------------------------------------
  let pdf: Buffer | null = null;
  let pdfPath = invoice.pdfPath;
  if (invoice.pdfState === 'pending') {
    try {
      pdf = await (deps.render ?? renderInvoicePdf)({ invoice, cancelsNumber });
      pdfPath = invoicePdfPath(invoice);
      const { error: uploadError } = await supabase.storage
        .from(INVOICE_BUCKET)
        .upload(pdfPath, pdf, { contentType: 'application/pdf', upsert: true });
      if (uploadError) throw uploadError;
      await update(supabase, invoice.id, {
        pdf_state: 'ready',
        pdf_path: pdfPath,
        pdf_error: null,
        next_attempt_at: null,
      });
      logger.info({ invoiceId: invoice.id }, 'invoice pdf stored');
    } catch (err) {
      await recordFailure(deps, invoice, 'pdf', row.pdf_attempts ?? 0, err);
      return;
    }
  }

  // --- 2. the mail ---------------------------------------------------------------
  if (invoice.mailState !== 'pending') {
    // nothing else to do; drop the lease
    await update(supabase, invoice.id, { next_attempt_at: null });
    return;
  }
  const failMail = (reason: string): Promise<void> =>
    update(supabase, invoice.id, {
      mail_state: 'failed',
      mail_error: reason,
      next_attempt_at: null,
    });
  if (!deps.from) return failMail('not_configured');
  const to = invoice.mailTo?.trim() ?? '';
  if (to === '' || isSuppressedEmailRecipient(to)) return failMail('no_recipient');

  try {
    if (!pdf) {
      if (!pdfPath) throw new Error('pdf path missing');
      const { data: file, error: downloadError } = await supabase.storage
        .from(INVOICE_BUCKET)
        .download(pdfPath);
      if (downloadError || !file) throw downloadError ?? new Error('pdf not found');
      pdf = Buffer.from(await file.arrayBuffer());
    }
    const appUrl = (deps.appUrl ?? DEFAULT_APP_URL).replace(/\/+$/, '');
    const rendered = renderInvoiceEmail({
      kind: invoice.kind,
      number: invoice.number,
      periodLabel: invoicePeriodLabel(invoice.period),
      grossText: formatCentsEur(invoice.grossCents),
      dueDateText:
        invoice.kind === 'invoice' && invoice.dueDate && invoice.grossCents > 0
          ? formatDateDe(invoice.dueDate)
          : null,
      cancelsNumber,
      recipientName: invoice.recipient.legalName,
      sellerName: invoice.seller.legalName,
      openUrl: invoice.orgId
        ? `${appUrl}/settings/billing?org=${encodeURIComponent(invoice.orgId)}`
        : null,
      appUrl,
    });
    await (deps.send ?? sendEmail)({
      from: deps.from,
      to,
      ...(invoice.seller.email ? { replyTo: invoice.seller.email } : {}),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      attachments: [
        {
          filename: invoiceFileName(invoice),
          content: pdf.toString('base64'),
          contentType: 'application/pdf',
        },
      ],
    });
    await update(supabase, invoice.id, {
      mail_state: 'sent',
      mail_sent_at: new Date((deps.now ?? Date.now)()).toISOString(),
      mail_error: null,
      next_attempt_at: null,
    });
    logger.info({ invoiceId: invoice.id }, 'invoice mail sent');
  } catch (err) {
    await recordFailure(deps, invoice, 'mail', row.mail_attempts ?? 0, err);
  }
}
