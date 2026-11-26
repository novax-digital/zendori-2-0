import { describe, expect, it } from 'vitest';
import { createLogger, type IssueFailureReason, type IssueResult } from '@zendori/core';
import {
  INVOICE_RUN_DELAY_MS,
  INVOICE_RUN_RETRY_AFTER_MS,
  dueInvoicePeriods,
  runInvoiceMonth,
  type InvoiceRunDeps,
} from '../src/billing/invoice-run.js';
import { createMemoryDb, type MemoryDb } from './memory-supabase.js';

// Phase 15b step 2: the monthly invoice run. Pins that it is off by default,
// never reaches back before the start month, issues once per customer and
// month, and tries a skipped customer again only when waiting can help.

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const logger = createLogger('test', 'silent');
const at = (iso: string): number => Date.parse(iso);

interface World {
  db: MemoryDb;
  deps: InvoiceRunDeps;
  clock: { now: number };
  calls: { orgId: string; period: string; userId: string | null }[];
  runs(): Record<string, unknown>[];
}

function world(options: {
  autoFrom: string | null;
  now: string;
  outcome?: (orgId: string) => IssueFailureReason | 'ok' | 'throw';
  runs?: Record<string, unknown>[];
}): World {
  const db = createMemoryDb({
    billing_seller: [{ id: true, auto_invoice_from: options.autoFrom }],
    organizations: [
      { id: A, created_at: '2026-01-01T00:00:00Z' },
      { id: B, created_at: '2026-02-01T00:00:00Z' },
      { id: C, created_at: '2026-03-01T00:00:00Z' },
    ],
    billing_invoice_runs: options.runs ?? [],
  });
  const clock = { now: at(options.now) };
  const calls: World['calls'] = [];
  return {
    db,
    clock,
    calls,
    deps: {
      supabase: db.client,
      logger,
      now: () => clock.now,
      issue: async (_admin, input): Promise<IssueResult> => {
        calls.push({ orgId: input.orgId, period: input.period, userId: input.userId });
        const result = options.outcome?.(input.orgId) ?? 'ok';
        if (result === 'throw') throw new Error('database hiccup');
        if (result === 'ok') {
          return {
            ok: true,
            invoice: { id: `inv-${input.orgId.slice(0, 4)}` } as never,
          };
        }
        return { ok: false, reason: result, error: 'x' };
      },
    },
    runs: () => db.rows('billing_invoice_runs'),
  };
}

describe('dueInvoicePeriods', () => {
  it('is off without a start month', () => {
    expect(dueInvoicePeriods(null, at('2027-01-15T00:00:00Z'))).toEqual([]);
    expect(dueInvoicePeriods('nonsense', at('2027-01-15T00:00:00Z'))).toEqual([]);
  });

  it('covers a month a few hours after it ended, not before', () => {
    const end = at('2027-01-01T00:00:00Z');
    expect(dueInvoicePeriods('2026-12', end + INVOICE_RUN_DELAY_MS - 1)).toEqual([]);
    expect(dueInvoicePeriods('2026-12', end + INVOICE_RUN_DELAY_MS)).toEqual(['2026-12']);
    // the running month is never due
    expect(dueInvoicePeriods('2026-12', at('2026-12-31T23:59:00Z'))).toEqual([]);
  });

  it('never reaches back before the start month', () => {
    // switched on in December for December: November and earlier stay manual
    expect(dueInvoicePeriods('2026-12', at('2027-01-10T00:00:00Z'))).toEqual(['2026-12']);
    expect(dueInvoicePeriods('2027-02', at('2027-01-10T00:00:00Z'))).toEqual([]);
  });

  it('catches up a few months after an outage, oldest first', () => {
    expect(dueInvoicePeriods('2026-01', at('2027-04-10T00:00:00Z'))).toEqual([
      '2027-01',
      '2027-02',
      '2027-03',
    ]);
  });
});

describe('runInvoiceMonth', () => {
  it('issues the invoice of every customer and remembers it', async () => {
    const w = world({ autoFrom: '2026-12', now: '2027-01-01T07:00:00Z' });
    const summary = await runInvoiceMonth(w.deps, '2026-12');
    expect(summary).toEqual({ period: '2026-12', issued: 3, skipped: 0, untouched: 0 });
    expect(w.calls.map((call) => call.orgId)).toEqual([A, B, C]);
    // issued by the run, not by a person
    expect(w.calls.every((call) => call.userId === null && call.period === '2026-12')).toBe(true);
    expect(w.runs()).toHaveLength(3);
    expect(w.runs()[0]).toMatchObject({
      org_id: A,
      period: '2026-12',
      outcome: 'issued',
      reason: null,
      invoice_id: 'inv-1111',
      attempts: 1,
    });
  });

  it('does nothing while the run is off or the month is not due', async () => {
    const off = world({ autoFrom: null, now: '2027-01-01T07:00:00Z' });
    await runInvoiceMonth(off.deps, '2026-12');
    expect(off.calls).toHaveLength(0);

    const early = world({ autoFrom: '2026-12', now: '2027-01-01T02:00:00Z' });
    await runInvoiceMonth(early.deps, '2026-12');
    expect(early.calls).toHaveLength(0);

    // a month before the start month is never invoiced, even if a job asks for it
    const before = world({ autoFrom: '2026-12', now: '2027-01-01T07:00:00Z' });
    await runInvoiceMonth(before.deps, '2026-11');
    expect(before.calls).toHaveLength(0);
    expect(before.runs()).toHaveLength(0);
  });

  it('a second run touches nobody who is done', async () => {
    const w = world({ autoFrom: '2026-12', now: '2027-01-01T07:00:00Z' });
    await runInvoiceMonth(w.deps, '2026-12');
    w.clock.now += 24 * 60 * 60_000;
    const again = await runInvoiceMonth(w.deps, '2026-12');
    expect(again).toMatchObject({ issued: 0, skipped: 0, untouched: 3 });
    expect(w.calls).toHaveLength(3);
  });

  it('records why a customer was skipped and goes on with the others', async () => {
    const w = world({
      autoFrom: '2026-12',
      now: '2027-01-01T07:00:00Z',
      outcome: (orgId) =>
        orgId === A ? 'missing_details' : orgId === B ? 'throw' : 'nothing_to_charge',
    });
    const summary = await runInvoiceMonth(w.deps, '2026-12');
    expect(summary).toMatchObject({ issued: 0, skipped: 3 });
    expect(w.runs().map((row) => [row.org_id, row.outcome, row.reason])).toEqual([
      [A, 'skipped', 'missing_details'],
      [B, 'skipped', 'error'],
      [C, 'skipped', 'nothing_to_charge'],
    ]);
  });

  it('tries a fixable skip again after a few hours — a final one never', async () => {
    let fixed = false;
    const w = world({
      autoFrom: '2026-12',
      now: '2027-01-01T07:00:00Z',
      outcome: (orgId) =>
        orgId === A ? (fixed ? 'ok' : 'missing_details') : orgId === B ? 'nothing_to_charge' : 'already_invoiced',
    });
    await runInvoiceMonth(w.deps, '2026-12');
    expect(w.calls).toHaveLength(3);

    // too soon: nobody is asked again
    w.clock.now += INVOICE_RUN_RETRY_AFTER_MS - 1;
    await runInvoiceMonth(w.deps, '2026-12');
    expect(w.calls).toHaveLength(3);

    // later, and the customer has entered billing details meanwhile
    fixed = true;
    w.clock.now += 2;
    const summary = await runInvoiceMonth(w.deps, '2026-12');
    expect(summary).toMatchObject({ issued: 1, skipped: 0, untouched: 2 });
    expect(w.calls).toHaveLength(4);
    expect(w.calls[3]).toMatchObject({ orgId: A });
    const row = w.runs().find((r) => r.org_id === A)!;
    expect(row).toMatchObject({ outcome: 'issued', reason: null, attempts: 2 });
  });

  it('does not invoice again a customer whose automatic invoice was issued', async () => {
    // e.g. the operator cancelled it: what happens next is the operator's decision
    const w = world({
      autoFrom: '2026-12',
      now: '2027-01-20T00:00:00Z',
      runs: [
        {
          org_id: A,
          period: '2026-12',
          outcome: 'issued',
          reason: null,
          invoice_id: 'inv-old',
          attempts: 1,
          updated_at: '2027-01-01T07:00:00Z',
        },
      ],
    });
    await runInvoiceMonth(w.deps, '2026-12');
    expect(w.calls.map((call) => call.orgId)).toEqual([B, C]);
  });
});
