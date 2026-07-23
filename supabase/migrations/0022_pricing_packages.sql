-- Zendori v2 — 0022: price tiers, packages, org subscriptions (Billing v2)
--
-- Extends the 0021 billing foundation from "one global markup" to a real pricing
-- product:
--   * price_tiers      — named sell-price conditions (Standard/Partner/…), a
--                        per-category override of the recommended price. Empty
--                        override ⇒ recommendation (cost × target_margin) applies.
--   * packages         — bundle: a price tier + setup fee + monthly/yearly base
--                        fee + per-channel-type fee & quota.
--   * org_subscriptions— which package/tier/interval a customer is on. Assigning
--                        a package pushes its channel quotas into org_channel_limits
--                        (0017) so existing enforcement keeps working unchanged.
--
-- All three are platform pricing config: service-role only (no member policies),
-- exactly like 0021. The customer sees prices only through the guarded rollup.

-- target margin: the default multiplier used for the recommended price and for
-- any category a tier does not explicitly override. price = cost × usd_to_eur ×
-- target_margin (unless the tier sets a fixed unit price / explicit markup).
alter table public.billing_settings
  add column if not exists target_margin numeric not null default 3.0 check (target_margin >= 0);

-- ============================================================================
-- price_tiers — named sell-price conditions
-- ============================================================================

create table public.price_tiers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- exactly one default tier (used for orgs without an explicit assignment)
  is_default boolean not null default false,
  -- per-category override, validated in app code (priceTierPricingSchema):
  --   { voice: {mode:'unit', unitPriceEur: 0.05},
  --     ai:    {mode:'markup', factor: 3.0}, ... }
  -- absent category ⇒ recommendation (cost × target_margin) applies.
  pricing jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

-- at most one default tier
create unique index price_tiers_default_idx on public.price_tiers ((is_default)) where is_default;

alter table public.price_tiers enable row level security;

-- seed a default tier with no overrides (⇒ everything uses the recommendation)
insert into public.price_tiers (name, is_default) values ('Standard', true);

-- ============================================================================
-- packages — sellable bundles
-- ============================================================================

create table public.packages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- usage prices for customers on this package
  price_tier_id uuid references public.price_tiers (id) on delete set null,
  setup_fee_eur numeric not null default 0 check (setup_fee_eur >= 0),
  base_fee_monthly_eur numeric not null default 0 check (base_fee_monthly_eur >= 0),
  base_fee_yearly_eur numeric not null default 0 check (base_fee_yearly_eur >= 0),
  -- per channel type: quota + monthly/yearly fee, validated in app code
  -- (packageChannelsSchema): { whatsapp: {quota: 2, feeMonthlyEur: 20, feeYearlyEur: 200}, … }
  channels jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

create index packages_active_idx on public.packages (is_active);

alter table public.packages enable row level security;

-- ============================================================================
-- org_subscriptions — a customer's current package/tier/interval
-- ============================================================================

create table public.org_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references public.organizations (id) on delete cascade,
  package_id uuid references public.packages (id) on delete set null,
  -- effective tier: defaults to the package's tier, but can be overridden to give
  -- this customer better conditions without changing the package.
  price_tier_id uuid references public.price_tiers (id) on delete set null,
  billing_interval text not null default 'monthly' check (billing_interval in ('monthly', 'yearly')),
  -- null ⇒ use the package's setup fee; set ⇒ override for this customer.
  setup_fee_eur numeric check (setup_fee_eur >= 0),
  started_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

create index org_subscriptions_package_idx on public.org_subscriptions (package_id);

alter table public.org_subscriptions enable row level security;
