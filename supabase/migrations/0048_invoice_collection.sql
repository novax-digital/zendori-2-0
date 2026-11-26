-- Zendori v2 — 0048: collecting an invoice through Stripe (Phase 15b, step 3)
--
-- Until now every invoice asks for a bank transfer. For a customer who is billed
-- through Stripe (the operator's switch, a payment method on file) the amount
-- is collected instead: the invoice says so and names the earliest date, and
-- on that date the worker charges the stored payment method.
--
--   billing_seller.collect_after_days   days between invoice date and the charge
--                                       (default 3; the invoice doubles as the
--                                       announcement a SEPA debit needs)
--   billing_invoices, FROZEN with the document:
--     payment_method   transfer | sepa_debit | card — what the invoice says
--     payment_label    e.g. "SEPA-Lastschrift •••• 3000"
--     collect_on       the earliest day of the charge, as printed
--   billing_invoices, the state of the charge (not part of the document):
--     collect_state    none | scheduled | processing | succeeded | failed | disputed
--     collect_livemode the Stripe mode the charge belongs to
--     stripe_payment_intent_id, collect_attempts, collect_error,
--     collect_started_at (a charge was begun — before another one is created,
--     the worker looks at Stripe whether that one exists), collect_next_attempt_at,
--     collected_at
--
-- A charge that fails or is reversed leaves the invoice OPEN and is shown to the
-- operator; there is no automatic second attempt (owner decision 2026-11-27).
-- A cancelled invoice is never charged: cancelling takes a scheduled charge back.
--
-- issue_billing_invoice gets four more arguments. The 16-argument form stays —
-- the code that runs until the deploy calls it — and now simply issues a
-- transfer invoice through the new one.
--
-- Additive only; all tables stay service-role only.

alter table public.billing_seller
  add column collect_after_days integer not null default 3
    check (collect_after_days >= 0 and collect_after_days <= 30);

alter table public.billing_invoices
  add column payment_method text not null default 'transfer'
    check (payment_method in ('transfer', 'sepa_debit', 'card')),
  add column payment_label text check (char_length(payment_label) <= 80),
  add column collect_on date,
  add column collect_state text not null default 'none'
    check (collect_state in ('none', 'scheduled', 'processing', 'succeeded', 'failed', 'disputed')),
  add column collect_livemode boolean,
  add column stripe_payment_intent_id text,
  add column collect_attempts integer not null default 0,
  add column collect_error text check (char_length(collect_error) <= 120),
  add column collect_started_at timestamptz,
  add column collect_next_attempt_at timestamptz,
  add column collected_at timestamptz,
  -- an invoice that is collected names its date; a transfer invoice has none
  add constraint billing_invoices_collect_on_check
    check ((payment_method = 'transfer') = (collect_on is null));

create unique index billing_invoices_payment_intent_idx
  on public.billing_invoices (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
-- the worker's to-do list: charges that are due, and running ones to look after
create index billing_invoices_collect_idx
  on public.billing_invoices (collect_on)
  where collect_state in ('scheduled', 'processing');

-- --- the three new document columns are frozen too ---------------------------------
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
     or new.payment_method is distinct from old.payment_method
     or new.payment_label is distinct from old.payment_label
     or new.collect_on is distinct from old.collect_on
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

-- --- issue a document, with how it is paid ------------------------------------------
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
  p_created_by uuid,
  p_payment_method text,
  p_payment_label text,
  p_collect_on date,
  p_collect_livemode boolean
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
  v_collected boolean := p_kind = 'invoice' and coalesce(p_payment_method, 'transfer') <> 'transfer';
begin
  select invoice_number_format, invoice_number_start into v_format, v_start
    from billing_seller;
  if v_format is null then
    raise exception 'billing_seller is not set up';
  end if;
  if v_collected and (p_collect_on is null or p_collect_livemode is null) then
    raise exception 'a collected invoice needs its date and its Stripe mode';
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
    cancels_invoice_id, payment_status, mail_state, mail_to, created_by,
    payment_method, payment_label, collect_on, collect_state, collect_livemode
  ) values (
    p_org_id, p_kind, v_number, v_year, v_seq, p_period, p_issue_date, p_due_date,
    p_seller, p_recipient, p_lines, p_tax_mode, p_tax_percent, p_net_cents, p_tax_cents, p_gross_cents,
    p_cancels_invoice_id,
    case when p_kind = 'cancellation' then 'void' else 'open' end,
    case when p_mail_to is null or p_mail_to = '' then 'none' else 'pending' end,
    nullif(p_mail_to, ''), p_created_by,
    case when v_collected then p_payment_method else 'transfer' end,
    case when v_collected then p_payment_label end,
    case when v_collected then p_collect_on end,
    case when v_collected then 'scheduled' else 'none' end,
    case when v_collected then p_collect_livemode end
  ) returning * into v_row;

  if p_kind = 'cancellation' then
    update billing_invoices
       set cancelled_by_invoice_id = v_row.id,
           payment_status = 'void',
           -- a cancelled invoice is not charged; a charge that is already
           -- under way or done stays visible as it is
           collect_state = case when collect_state = 'scheduled' then 'none' else collect_state end,
           collect_next_attempt_at = case when collect_state = 'scheduled' then null else collect_next_attempt_at end
     where id = p_cancels_invoice_id;
  end if;

  return v_row;
end;
$$;

-- the form the running code calls: a transfer invoice
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
language sql
security invoker
set search_path = public
as $$
  select * from public.issue_billing_invoice(
    p_org_id, p_kind, p_period, p_issue_date, p_due_date, p_seller, p_recipient, p_lines,
    p_tax_mode, p_tax_percent, p_net_cents, p_tax_cents, p_gross_cents, p_mail_to,
    p_cancels_invoice_id, p_created_by, 'transfer', null, null, null);
$$;

revoke all on function public.issue_billing_invoice(uuid, text, text, date, date, jsonb, jsonb, jsonb, text, numeric, integer, integer, integer, text, uuid, uuid, text, text, date, boolean) from public;
revoke all on function public.issue_billing_invoice(uuid, text, text, date, date, jsonb, jsonb, jsonb, text, numeric, integer, integer, integer, text, uuid, uuid, text, text, date, boolean) from anon;
revoke all on function public.issue_billing_invoice(uuid, text, text, date, date, jsonb, jsonb, jsonb, text, numeric, integer, integer, integer, text, uuid, uuid, text, text, date, boolean) from authenticated;
grant execute on function public.issue_billing_invoice(uuid, text, text, date, date, jsonb, jsonb, jsonb, text, numeric, integer, integer, integer, text, uuid, uuid, text, text, date, boolean) to service_role;
