-- Zendori v2 — 0047: the monthly invoice run (Phase 15b, step 2)
--
-- Until now an invoice is created by hand, for a customer and a finished month
-- (0046). From a month the operator chooses, the worker does it by itself:
-- shortly after a month has ended it issues the invoice of every customer for
-- that month — with the same code and the same rules as the button.
--
--   billing_seller.auto_invoice_from   first month (YYYY-MM) the run covers;
--                                      null = no automatic invoices (default)
--   billing_invoice_runs               what the run did for (customer, month):
--                                      issued, or skipped and why
--
-- Nothing starts with this migration: auto_invoice_from stays null until the
-- operator sets it, and the app only offers the current month or a later one —
-- months that are already over are never invoiced automatically.
--
-- A skipped customer is tried again later when the reason can go away (billing
-- details missing, VAT id not confirmed, seller incomplete, an error). "Nothing
-- to charge" and "already invoiced" are final. A customer whose automatic
-- invoice was cancelled is not invoiced again by the run.
--
-- Service role only, like every billing table (0022): RLS on, no policies.

alter table public.billing_seller
  add column auto_invoice_from text
    check (auto_invoice_from is null or auto_invoice_from ~ '^\d{4}-(0[1-9]|1[0-2])$');

create table public.billing_invoice_runs (
  org_id uuid not null references public.organizations (id) on delete cascade,
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  outcome text not null check (outcome in ('issued', 'skipped')),
  -- why it was skipped (IssueFailureReason in packages/core); null when issued
  reason text check (char_length(reason) <= 40),
  invoice_id uuid references public.billing_invoices (id),
  attempts integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, period),
  check ((outcome = 'issued') = (reason is null))
);

create index billing_invoice_runs_period_idx on public.billing_invoice_runs (period, outcome);

alter table public.billing_invoice_runs enable row level security;
-- no policies: service role only
