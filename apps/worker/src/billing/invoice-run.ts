// The monthly invoice run (Phase 15b step 2, migration 0047): shortly after a
// month has ended, issue the invoice of every customer for that month — with
// issueInvoiceForMonth, the same function the "Rechnung erstellen" button calls.
// The PDF and the mail then follow through the usual document job.
//
// Off until the operator sets a start month (billing_seller.auto_invoice_from).
// Only months from that one on are covered, so nothing that was already over
// when the run was switched on is ever invoiced automatically.
//
// What the run did for a customer and a month is kept in billing_invoice_runs:
//   issued                  done — also when the invoice is cancelled later
//   skipped, final reason   nothing to charge / already invoiced by hand
//   skipped, other reason   tried again every few hours: the reason can go away
//                           (billing details arrive, a VAT id gets confirmed)
import {
  ISSUE_FINAL_REASONS,
  invoicePeriodLabel,
  isMissingColumnError,
  isMissingRelationError,
  isPeriodKey,
  issueInvoiceForMonth,
  periodKeyOf,
  shiftPeriodKey,
  type IssueFailureReason,
  type Logger,
  type SupabaseClient,
} from '@zendori/core';
import { toErrorInfo } from '../db.js';

export const INVOICE_RUN_QUEUE = 'billing.invoice-run';
export const INVOICE_RUN_RETRY_LIMIT = 0;

/** A month is invoiced this long after it ended (UTC), so late usage is in. */
export const INVOICE_RUN_DELAY_MS = 6 * 60 * 60_000;
/** A skipped customer whose reason can go away is tried again after this long. */
export const INVOICE_RUN_RETRY_AFTER_MS = 6 * 60 * 60_000;
/** How far back the run catches up after the worker was down (months). */
export const INVOICE_RUN_CATCH_UP_MONTHS = 3;

export interface InvoiceRunJob {
  period: string;
}

export interface InvoiceRunDeps {
  supabase: SupabaseClient;
  logger: Logger;
  now?: () => number;
  /** Injectable for tests. */
  issue?: typeof issueInvoiceForMonth;
}

/** First instant of the month after `period` (UTC), in ms. */
function periodEndMs(period: string): number {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return Date.UTC(year, month, 1);
}

/**
 * The months the run has to look at now: finished long enough, not before the
 * start month, and at most a few months back. Empty while the run is off.
 */
export function dueInvoicePeriods(autoInvoiceFrom: string | null, nowMs: number): string[] {
  if (!isPeriodKey(autoInvoiceFrom)) return [];
  const current = periodKeyOf(new Date(nowMs));
  const periods: string[] = [];
  for (let back = 1; back <= INVOICE_RUN_CATCH_UP_MONTHS; back += 1) {
    const period = shiftPeriodKey(current, -back);
    if (period < autoInvoiceFrom) break;
    if (nowMs < periodEndMs(period) + INVOICE_RUN_DELAY_MS) continue;
    periods.push(period);
  }
  return periods.reverse();
}

/** Reads the start month; null = off, or the migration is not applied yet. */
export async function loadAutoInvoiceFrom(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from('billing_seller')
    .select('auto_invoice_from')
    .maybeSingle();
  if (error) {
    if (isMissingRelationError(error) || isMissingColumnError(error)) return null;
    throw error;
  }
  const value = (data as { auto_invoice_from: string | null } | null)?.auto_invoice_from ?? null;
  return isPeriodKey(value) ? value : null;
}

interface RunRow {
  org_id: string;
  outcome: 'issued' | 'skipped';
  reason: string | null;
  attempts: number;
  updated_at: string;
}

export interface InvoiceRunSummary {
  period: string;
  issued: number;
  skipped: number;
  /** Customers the run did not touch (done, final, or tried recently). */
  untouched: number;
}

/**
 * Works through every customer for one finished month. Safe to run again and
 * again: a customer that is done is not touched, and the database refuses a
 * second invoice for the same customer and month whatever happens here.
 */
export async function runInvoiceMonth(
  deps: InvoiceRunDeps,
  period: string
): Promise<InvoiceRunSummary> {
  const { supabase, logger } = deps;
  const nowMs = (deps.now ?? Date.now)();
  const summary: InvoiceRunSummary = { period, issued: 0, skipped: 0, untouched: 0 };

  // the start month is read again: the run may have been switched off meanwhile
  const autoFrom = await loadAutoInvoiceFrom(supabase);
  if (!dueInvoicePeriods(autoFrom, nowMs).includes(period)) return summary;

  const [{ data: orgData, error: orgError }, { data: runData, error: runError }] = await Promise.all(
    [
      supabase.from('organizations').select('id').order('created_at', { ascending: true }),
      supabase
        .from('billing_invoice_runs')
        .select('org_id, outcome, reason, attempts, updated_at')
        .eq('period', period),
    ]
  );
  if (orgError) throw orgError;
  if (runError) {
    if (isMissingRelationError(runError)) return summary;
    throw runError;
  }
  const runs = new Map(((runData ?? []) as RunRow[]).map((row) => [row.org_id, row]));

  for (const org of (orgData ?? []) as { id: string }[]) {
    const previous = runs.get(org.id);
    if (previous) {
      const final =
        previous.outcome === 'issued' ||
        ISSUE_FINAL_REASONS.includes(previous.reason as IssueFailureReason);
      const recent = nowMs - Date.parse(previous.updated_at) < INVOICE_RUN_RETRY_AFTER_MS;
      if (final || recent) {
        summary.untouched += 1;
        continue;
      }
    }

    let outcome: 'issued' | 'skipped';
    let reason: IssueFailureReason | null = null;
    let invoiceId: string | null = null;
    try {
      const result = await (deps.issue ?? issueInvoiceForMonth)(supabase, {
        orgId: org.id,
        period,
        userId: null,
        now: new Date(nowMs),
      });
      if (result.ok) {
        outcome = 'issued';
        invoiceId = result.invoice.id;
      } else {
        outcome = 'skipped';
        reason = result.reason;
      }
    } catch (err) {
      outcome = 'skipped';
      reason = 'error';
      logger.warn({ orgId: org.id, period, err: toErrorInfo(err) }, 'invoice run: customer failed');
    }

    // one row per customer and month (primary key); the queue runs one month at a time
    const values = {
      outcome,
      reason,
      invoice_id: invoiceId,
      attempts: (previous?.attempts ?? 0) + 1,
      updated_at: new Date(nowMs).toISOString(),
    };
    const { error: writeError } = previous
      ? await supabase
          .from('billing_invoice_runs')
          .update(values)
          .eq('org_id', org.id)
          .eq('period', period)
      : await supabase
          .from('billing_invoice_runs')
          .insert({ org_id: org.id, period, ...values });
    if (writeError) throw writeError;
    if (outcome === 'issued') summary.issued += 1;
    else summary.skipped += 1;
  }

  logger.info(
    { ...summary, label: invoicePeriodLabel(period) },
    'invoice run finished for a month'
  );
  return summary;
}
