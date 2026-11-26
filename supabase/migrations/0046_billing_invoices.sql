-- Zendori v2 — 0046: own invoices (Phase 15b, step 1)
--
-- Owner decision 2026-11-27: Zendori issues the invoices itself — not Stripe,
-- and not an external invoicing tool. Every customer gets the same document,
-- from one number range, whether they are billed through Stripe or not; Stripe
-- only collects the amount (a later step).
--
--   billing_seller             the operator's own details on every invoice
--                              (one row), number format, payment term
--   billing_invoice_counters   last number handed out per year
--   billing_invoices           one row per issued document: an invoice for
--                              (customer, month) or the cancellation of one
--   billing_accounts.vat_id_confirmed_*   the operator vouches for a customer's
--                              VAT id, independent of Stripe
--   storage bucket `invoices`  the PDFs (private)
--
-- An issued invoice is FROZEN: seller, recipient, lines and amounts are stored
-- as they were on the day of issue, and a trigger refuses any later change to
-- them and any delete. A mistake is corrected by a cancellation document
-- (kind 'cancellation', own number, negative amounts) and a new invoice.
--
-- The number is handed out inside issue_billing_invoice(), in the same
-- transaction that stores the invoice: a failed insert takes the number back,
-- so the range has no gaps.
--
-- billing_invoices.org_id is ON DELETE SET NULL on purpose: an invoice is the
-- operator's tax record and outlives the customer's organization (org.purge
-- removes the customer's data, not the operator's bookkeeping). The recipient
-- is part of the frozen document.
--
-- Service role only, like every billing table (0022): RLS on, no policies. A
-- customer sees their invoices through the app, behind the membership check.
--
-- Nothing here creates an invoice by itself. Invoices are created by hand in
-- the admin area; the monthly run is a later step.

-- --- the operator on the invoice -------------------------------------------------------
create table public.billing_seller (
  -- exactly one row
  id boolean primary key default true check (id),
  legal_name text,
  address_line1 text,
  address_line2 text,
  postal_code text,
  city text,
  country text not null default 'DE',
  vat_id text,
  tax_number text,
  register_court text,
  register_number text,
  managing_directors text,
  email text,
  phone text,
  website text,
  bank_name text,
  iban text,
  bic text,
  -- {YYYY} / {YY} = year of issue, {NNNN} = running number, as many digits as N's
  invoice_number_format text not null default 'ZD-{YYYY}-{NNNN}'
    check (invoice_number_format ~ '\{N+\}' and char_length(invoice_number_format) <= 40),
  -- first number of a year (a year that already has invoices simply continues)
  invoice_number_start integer not null default 1 check (invoice_number_start >= 1),
  payment_term_days integer not null default 14
    check (payment_term_days >= 0 and payment_term_days <= 90),
  footer_note text check (char_length(footer_note) <= 500),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

alter table public.billing_seller enable row level security;

-- What the website's legal notice says (public information). Bank details are
-- left to the operator; without them no invoice can be issued.
insert into public.billing_seller
  (legal_name, address_line1, postal_code, city, country, vat_id,
   register_court, register_number, managing_directors, email, website)
values
  ('Novax Digital GmbH', 'Schierholzstr. 27', '30655', 'Hannover', 'DE', 'DE335613731',
   'Amtsgericht Hannover', 'HRB 220589', 'Philipp Polley, Christoph Pfad',
   'info@zendori.ai', 'zendori.ai');

-- --- the customer's VAT id, confirmed by the operator -------------------------------
-- Until now the confirmation lived on the Stripe row of one mode. An invoice
-- that does not depend on Stripe needs it on the account itself.
alter table public.billing_accounts
  add column vat_id_confirmed_value text,
  add column vat_id_confirmed_at timestamptz,
  add column vat_id_confirmed_by uuid references auth.users (id) on delete set null;

-- --- number range -------------------------------------------------------------------
create table public.billing_invoice_counters (
  year integer primary key check (year >= 2000 and year <= 2999),
  last_number integer not null check (last_number >= 0)
);

alter table public.billing_invoice_counters enable row level security;

-- --- invoices -----------------------------------------------------------------------
create table public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  -- SET NULL: the document outlives the organization
  org_id uuid references public.organizations (id) on delete set null,
  kind text not null default 'invoice' check (kind in ('invoice', 'cancellation')),
  number text not null unique,
  number_year integer not null,
  number_seq integer not null,
  -- the month the invoice is for (YYYY-MM)
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  issue_date date not null,
  -- null on a cancellation
  due_date date,

  -- the frozen document (zod: packages/core/src/billing-invoice.ts)
  seller jsonb not null check (jsonb_typeof(seller) = 'object'),
  recipient jsonb not null check (jsonb_typeof(recipient) = 'object'),
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  tax_mode text not null check (tax_mode in ('de_vat', 'eu_reverse_charge')),
  tax_percent numeric not null check (tax_percent >= 0 and tax_percent <= 100),
  net_cents integer not null,
  tax_cents integer not null,
  gross_cents integer not null,
  currency text not null default 'EUR' check (currency = 'EUR'),
  check (net_cents + tax_cents = gross_cents),

  -- an invoice and its cancellation point at each other
  cancels_invoice_id uuid references public.billing_invoices (id),
  cancelled_by_invoice_id uuid references public.billing_invoices (id),

  -- open → paid; void = cancelled, or the cancellation document itself
  payment_status text not null default 'open' check (payment_status in ('open', 'paid', 'void')),
  paid_at timestamptz,
  paid_via text check (paid_via in ('manual', 'stripe')),
  paid_note text check (char_length(paid_note) <= 300),
  paid_by uuid references auth.users (id) on delete set null,

  -- the PDF (rendered by the worker from the frozen document)
  pdf_state text not null default 'pending' check (pdf_state in ('pending', 'ready', 'failed')),
  pdf_path text,
  pdf_attempts integer not null default 0,
  pdf_error text check (char_length(pdf_error) <= 200),
  -- the e-mail with the PDF
  mail_state text not null default 'none'
    check (mail_state in ('none', 'pending', 'sent', 'failed')),
  mail_to text,
  mail_sent_at timestamptz,
  mail_attempts integer not null default 0,
  mail_error text check (char_length(mail_error) <= 200),
  -- when the worker tries the PDF / the mail next (null = now)
  next_attempt_at timestamptz,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (number_year, number_seq)
);

-- one live invoice per customer and month; a cancelled one makes room for a new one
create unique index billing_invoices_org_period_idx
  on public.billing_invoices (org_id, period)
  where kind = 'invoice' and cancelled_by_invoice_id is null;
create index billing_invoices_org_idx on public.billing_invoices (org_id, issue_date desc);
-- the worker's to-do list
create index billing_invoices_work_idx on public.billing_invoices (created_at)
  where pdf_state = 'pending' or mail_state = 'pending';

alter table public.billing_invoices enable row level security;
-- no policies on any of the three tables: service role only

-- --- an issued document cannot be changed or deleted --------------------------------
create or replace function private.guard_billing_invoice()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'an issued invoice cannot be deleted (cancel it instead)';
  end if;
  if new.kind is distinct from old.kind
     or new.number is distinct from old.number
     or new.number_year is distinct from old.number_year
     or new.number_seq is distinct from old.number_seq
     or new.period is distinct from old.period
     or new.issue_date is distinct from old.issue_date
     or new.due_date is distinct from old.due_date
     or new.seller is distinct from old.seller
     or new.recipient is distinct from old.recipient
     or new.lines is distinct from old.lines
     or new.tax_mode is distinct from old.tax_mode
     or new.tax_percent is distinct from old.tax_percent
     or new.net_cents is distinct from old.net_cents
     or new.tax_cents is distinct from old.tax_cents
     or new.gross_cents is distinct from old.gross_cents
     or new.currency is distinct from old.currency
     or new.cancels_invoice_id is distinct from old.cancels_invoice_id
     or new.created_at is distinct from old.created_at
     -- the organization may only go away (org.purge), never change
     or (new.org_id is distinct from old.org_id and new.org_id is not null)
     -- a cancellation is final
     or (old.cancelled_by_invoice_id is not null
         and new.cancelled_by_invoice_id is distinct from old.cancelled_by_invoice_id) then
    raise exception 'an issued invoice cannot be changed (cancel it instead)';
  end if;
  return new;
end;
$$;

create trigger billing_invoices_guard
  before update or delete on public.billing_invoices
  for each row execute function private.guard_billing_invoice();

-- --- issue a document ---------------------------------------------------------------
-- Hands out the next number of the year and stores the document, in one
-- transaction. For a cancellation the original is marked cancelled and void in
-- the same step. The caller (the app, behind the platform-admin check) has
-- calculated and frozen the content; nothing is recalculated here.
create or replace function public.issue_billing_invoice(
  p_org_id uuid,
  p_kind text,
  p_period text,
  p_issue_date date,
  p_due_date date,
  p_seller jsonb,
  p_recipient jsonb,
  p_lines jsonb,
  p_tax_mode text,
  p_tax_percent numeric,
  p_net_cents integer,
  p_tax_cents integer,
  p_gross_cents integer,
  p_mail_to text,
  p_cancels_invoice_id uuid,
  p_created_by uuid
) returns public.billing_invoices
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_format text;
  v_start integer;
  v_year integer := extract(year from p_issue_date)::integer;
  v_seq integer;
  v_digits text;
  v_number text;
  v_original billing_invoices;
  v_row billing_invoices;
begin
  select invoice_number_format, invoice_number_start into v_format, v_start
    from billing_seller;
  if v_format is null then
    raise exception 'billing_seller is not set up';
  end if;

  if p_kind = 'cancellation' then
    select * into v_original from billing_invoices where id = p_cancels_invoice_id for update;
    if v_original.id is null or v_original.kind <> 'invoice' then
      raise exception 'the invoice to cancel was not found';
    end if;
    if v_original.cancelled_by_invoice_id is not null then
      raise exception 'this invoice is already cancelled';
    end if;
  elsif p_cancels_invoice_id is not null then
    raise exception 'only a cancellation refers to another invoice';
  end if;

  -- next number of the year; the row lock serializes concurrent issues
  insert into billing_invoice_counters (year, last_number)
  values (v_year, v_start)
  on conflict (year) do update set last_number = billing_invoice_counters.last_number + 1
  returning last_number into v_seq;

  -- {NNNN}: zero-padded to as many digits as there are N's (longer numbers grow)
  v_digits := substring(v_format from '\{(N+)\}');
  v_number := replace(
    replace(
      regexp_replace(v_format, '\{N+\}', lpad(v_seq::text, greatest(length(v_digits), length(v_seq::text)), '0')),
      '{YYYY}', v_year::text),
    '{YY}', lpad((v_year % 100)::text, 2, '0'));

  insert into billing_invoices (
    org_id, kind, number, number_year, number_seq, period, issue_date, due_date,
    seller, recipient, lines, tax_mode, tax_percent, net_cents, tax_cents, gross_cents,
    cancels_invoice_id, payment_status, mail_state, mail_to, created_by
  ) values (
    p_org_id, p_kind, v_number, v_year, v_seq, p_period, p_issue_date, p_due_date,
    p_seller, p_recipient, p_lines, p_tax_mode, p_tax_percent, p_net_cents, p_tax_cents, p_gross_cents,
    p_cancels_invoice_id,
    case when p_kind = 'cancellation' then 'void' else 'open' end,
    case when p_mail_to is null or p_mail_to = '' then 'none' else 'pending' end,
    nullif(p_mail_to, ''), p_created_by
  ) returning * into v_row;

  if p_kind = 'cancellation' then
    update billing_invoices
       set cancelled_by_invoice_id = v_row.id,
           payment_status = 'void'
     where id = p_cancels_invoice_id;
  end if;

  return v_row;
end;
$$;

revoke all on function public.issue_billing_invoice(uuid, text, text, date, date, jsonb, jsonb, jsonb, text, numeric, integer, integer, integer, text, uuid, uuid) from public;
revoke all on function public.issue_billing_invoice(uuid, text, text, date, date, jsonb, jsonb, jsonb, text, numeric, integer, integer, integer, text, uuid, uuid) from anon;
revoke all on function public.issue_billing_invoice(uuid, text, text, date, date, jsonb, jsonb, jsonb, text, numeric, integer, integer, integer, text, uuid, uuid) from authenticated;
grant execute on function public.issue_billing_invoice(uuid, text, text, date, date, jsonb, jsonb, jsonb, text, numeric, integer, integer, integer, text, uuid, uuid) to service_role;

-- --- the PDFs -----------------------------------------------------------------------
-- Private bucket; no storage policies: only the service role reads and writes.
-- The app hands out a short-lived signed link after its own access check.
insert into storage.buckets (id, name, public)
values ('invoices', 'invoices', false)
on conflict (id) do nothing;
