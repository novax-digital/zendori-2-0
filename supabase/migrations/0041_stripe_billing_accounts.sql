-- Zendori v2 — 0041: Stripe billing accounts (Phase 15a)
--
-- Zendori keeps calculating (price lists, packages, usage ledger); Stripe only
-- collects. This migration adds what an invoice needs before it can exist:
-- who is billed, and how.
--
--   · billing_accounts            an org's billing details: legal name, address,
--                                 country, VAT id, billing e-mail. Zendori is the
--                                 source of truth; the worker pushes them to Stripe.
--   · billing_stripe_customers    the Stripe side of an org, ONE ROW PER MODE
--                                 (test / live): the operator's switch "bill through
--                                 Stripe" + first month, the Stripe customer, the
--                                 stored payment method (type and last four digits
--                                 only) and the result of the VAT id check.
--   · stripe_events               webhook inbox: the event id and the ids it points
--                                 at — never a payload. The worker then reads the
--                                 current object from Stripe.
--
-- Why one row per mode: the operator tests on production with Stripe test keys
-- and switches to live keys afterwards. With a single row the switch would bill
-- every test-enabled org for real, and a worker that still runs on the other key
-- would overwrite the customer id. Each process only ever touches rows of the
-- mode of its own key.
--
-- All three tables are service-role only (like org_subscriptions, usage_events):
-- RLS enabled, no policies. The web app reads and writes them behind its own
-- access checks (owner/admin of the org, or platform admin).
--
-- Nothing here is content: no message text, no payment data beyond the label
-- "SEPA-Lastschrift •••• 3000" (§7).
--
-- Rollout order: app deploy first (web and worker treat the missing tables as
-- "Stripe billing not available yet"), then apply this migration.

-- --- billing details ----------------------------------------------------------------
create table public.billing_accounts (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  legal_name text check (legal_name is null or char_length(legal_name) <= 150),
  address_line1 text check (address_line1 is null or char_length(address_line1) <= 200),
  address_line2 text check (address_line2 is null or char_length(address_line2) <= 200),
  postal_code text check (postal_code is null or char_length(postal_code) <= 20),
  city text check (city is null or char_length(city) <= 100),
  -- ISO 3166-1 alpha-2; which countries can be billed is decided in
  -- packages/core/src/billing-tax.ts (EU), not here
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  -- normalized: upper case, no separators
  vat_id text check (vat_id is null or vat_id ~ '^[A-Z]{2}[A-Z0-9+*]{2,12}$'),
  billing_email text check (billing_email is null or char_length(billing_email) <= 254),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

alter table public.billing_accounts enable row level security;
-- RLS without policies: service role only.

-- --- the Stripe side, per mode ------------------------------------------------------
create table public.billing_stripe_customers (
  org_id uuid not null references public.organizations (id) on delete cascade,
  -- false = Stripe test mode, true = live
  livemode boolean not null,
  -- set by the platform admin; off = this org is never invoiced through Stripe
  enabled boolean not null default false,
  -- first billing month (YYYY-MM, UTC) that is invoiced through Stripe
  invoice_from text check (invoice_from is null or invoice_from ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  -- the Stripe account the ids below belong to (tells two sandboxes apart)
  stripe_account_id text,
  stripe_customer_id text,
  -- part of the idempotency key of the creating request; counted up when a
  -- customer that was deleted in Stripe has to be created again
  customer_generation integer not null default 0,
  -- default payment method: never more than type and a display label
  payment_method_id text,
  payment_method_type text check (payment_method_type in ('card', 'sepa_debit')),
  payment_method_label text check (payment_method_label is null or char_length(payment_method_label) <= 60),
  -- VIES check Stripe ran, and the VAT id it was run for
  vat_id_value text,
  vat_id_status text check (vat_id_status in ('pending', 'verified', 'unverified', 'unavailable')),
  -- the operator's manual confirmation, and the VAT id it was given for
  vat_id_confirmed_value text,
  vat_id_confirmed_by uuid references auth.users (id) on delete set null,
  vat_id_confirmed_at timestamptz,
  -- "bring Stripe up to date": set by the web app, worked off by the worker
  sync_requested_at timestamptz,
  sync_attempts integer not null default 0,
  sync_next_attempt_at timestamptz,
  -- content-free code of the last failed attempt, e.g. stripe:401
  sync_error text,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  primary key (org_id, livemode),
  constraint billing_stripe_customers_enabled_from_check
    check (not enabled or invoice_from is not null)
);

-- one org per Stripe customer; also the lookup of an incoming event
create unique index billing_stripe_customers_customer_idx
  on public.billing_stripe_customers (stripe_customer_id)
  where stripe_customer_id is not null;
create index billing_stripe_customers_payment_method_idx
  on public.billing_stripe_customers (payment_method_id)
  where payment_method_id is not null;
create index billing_stripe_customers_sync_idx
  on public.billing_stripe_customers (sync_requested_at)
  where sync_requested_at is not null;

alter table public.billing_stripe_customers enable row level security;
-- RLS without policies: service role only.

-- --- webhook inbox ------------------------------------------------------------------
create table public.stripe_events (
  -- Stripe's event id: a second delivery of the same event hits the primary key
  event_id text primary key check (char_length(event_id) <= 255),
  type text not null check (char_length(type) <= 100),
  livemode boolean not null,
  -- what the event is about: ids only
  object_type text check (object_type is null or char_length(object_type) <= 100),
  object_id text check (object_id is null or char_length(object_id) <= 255),
  customer_id text check (customer_id is null or char_length(customer_id) <= 255),
  state text not null default 'pending'
    check (state in ('pending', 'done', 'skipped', 'failed')),
  attempts integer not null default 0,
  -- when the worker may try (again); also the claim lease while a try runs
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index stripe_events_due_idx
  on public.stripe_events (next_attempt_at)
  where state = 'pending';
create index stripe_events_created_idx on public.stripe_events (created_at);

alter table public.stripe_events enable row level security;
-- RLS without policies: the webhook route and the worker (service role) only.
