-- Zendori v2 — 0042: package terms + a customer's own values (Preise & Pakete)
--
-- Owner request 2026-11-25: the pricing pages were clunky, and individual
-- conditions needed a whole new package or price list. From now on
--
--   · the PACKAGE is the standard, and a CUSTOMER only holds deviations
--     ("eigene Werte"): its own base fee, its own number of channels or fee per
--     channel, its own unit price for single positions. Empty = as in the package.
--     (org_subscriptions.setup_fee_eur and .price_tier_id already work this way.)
--   · only MONTHLY amounts are entered. The yearly price is 12 × monthly minus
--     a discount in percent — per package, overridable per customer.
--
--   packages.yearly_discount_percent              0–100, default 0
--   org_subscriptions.base_fee_monthly_eur        own base fee; null = package
--   org_subscriptions.yearly_discount_percent     own discount; null = package
--   org_subscriptions.channels                    {kind: {quota?, feeMonthlyEur?}}
--   org_subscriptions.pricing                     own unit price per position
--                                                 (same shape as price_tiers.pricing)
--
-- The old yearly amounts (packages.base_fee_yearly_eur, channels[].feeYearlyEur)
-- stay and are kept consistent — the app writes them as 12 × monthly minus the
-- discount — but nothing reads them any more. In production they were 0 while
-- the monthly fee was not: a customer on a yearly term would have paid nothing.
--
-- Additive only: no column is dropped, no policy changes (all three tables stay
-- service-role only, 0022). Two data fixes, both invoice-neutral for every
-- existing customer (all on a monthly term):
--   1. the stored yearly amounts become 12 × monthly (discount 0);
--   2. a customer whose price list was set to exactly the list they would get
--      anyway is un-pinned, so a later change of the package's list reaches them.
--
-- Rollout order: this migration FIRST, then the app. The running code selects
-- its columns by name and does not see the new ones; the new code also runs
-- without them (missing column = no discount, no own values).

-- --- package: discount on a yearly term ---------------------------------------------
alter table public.packages
  add column yearly_discount_percent numeric not null default 0
    check (yearly_discount_percent >= 0 and yearly_discount_percent <= 100);

-- --- customer: own values ------------------------------------------------------------
alter table public.org_subscriptions
  add column base_fee_monthly_eur numeric check (base_fee_monthly_eur >= 0),
  add column yearly_discount_percent numeric
    check (yearly_discount_percent >= 0 and yearly_discount_percent <= 100),
  -- zod: subscriptionOwnChannelsSchema (packages/core/src/billing.ts)
  add column channels jsonb not null default '{}'::jsonb
    check (jsonb_typeof(channels) = 'object'),
  -- zod: priceTierPricingSchema
  add column pricing jsonb not null default '{}'::jsonb
    check (jsonb_typeof(pricing) = 'object');

-- --- data fix 1: yearly amounts follow the monthly ones -----------------------------
update public.packages p
   set base_fee_yearly_eur = round(12 * p.base_fee_monthly_eur, 2),
       channels = coalesce(
         (select jsonb_object_agg(
                   term.key,
                   term.value || jsonb_build_object(
                     'feeYearlyEur',
                     round(12 * coalesce((term.value ->> 'feeMonthlyEur')::numeric, 0), 2)
                   )
                 )
            from jsonb_each(p.channels) as term
           where jsonb_typeof(term.value) = 'object'),
         '{}'::jsonb
       )
 where jsonb_typeof(p.channels) = 'object';

-- --- data fix 2: un-pin a price list that is the customer's list anyway -------------
update public.org_subscriptions s
   set price_tier_id = null
 where s.price_tier_id is not null
   and s.price_tier_id = coalesce(
         (select p.price_tier_id from public.packages p where p.id = s.package_id),
         (select t.id from public.price_tiers t where t.is_default)
       );
