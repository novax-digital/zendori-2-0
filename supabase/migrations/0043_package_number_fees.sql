-- Zendori v2 — 0043: the fee per phone number moves from the price list into the package
--
-- Owner request 2026-11-26: separate the two kinds of prices clearly.
--
--   · the USAGE PRICE LIST ("Verbrauchspreisliste", price_tiers) holds only what
--     is charged per unit: KI, minutes, messages, e-mails, data actions;
--   · the PACKAGE holds everything that is paid per month: base fee, channels
--     and — new — the fee per phone number (mobile / landline).
--
--   packages.numbers             {kind: {feeMonthlyEur}}, kind = mobile | landline
--                                absent kind = our purchase cost is passed on
--   org_subscriptions.numbers    a customer's own fee per number; absent = package
--
-- Charged is fee × ACTIVE numbers of the customer (phone_numbers, status active —
-- counted by billing_org_rollup, unchanged). A customer without a number pays
-- nothing. The yearly discount does not apply to numbers (it did not while they
-- stood on the price list). Without a package numbers are passed on at cost.
--
-- Additive only: two columns, no policy changes (both tables stay service-role
-- only, 0022). The data move below is invoice-neutral and proves it: the last
-- block raises if any customer would be charged a different fee per number
-- than before.
--
-- price_tiers.pricing and org_subscriptions.pricing keep their old
-- numbers_mobile / numbers_landline keys for now: the code that runs until the
-- deploy still reads them. The new code ignores them, and they disappear from a
-- row with its next save.
--
-- Rollout order: this migration FIRST, then the app. The running code selects
-- its columns by name and does not see the new ones; the new code also runs
-- without them (missing column = no package prices a number = purchase cost).

alter table public.packages
  -- zod: numberFeesSchema (packages/core/src/billing.ts)
  add column numbers jsonb not null default '{}'::jsonb
    check (jsonb_typeof(numbers) = 'object');

alter table public.org_subscriptions
  -- zod: numberFeesSchema
  add column numbers jsonb not null default '{}'::jsonb
    check (jsonb_typeof(numbers) = 'object');

-- The unit price a pricing object holds for a position; null = not priced.
create function pg_temp.unit_price(pricing jsonb, category text) returns numeric
  language sql immutable as $$
    select case
             when pricing -> category ->> 'mode' = 'unit'
               then (pricing -> category ->> 'unitPriceEur')::numeric
           end
  $$;

-- --- data move 1: a package takes the number fees of its price list ------------------
update public.packages p
   set numbers = jsonb_strip_nulls(jsonb_build_object(
         'mobile',
         case when pg_temp.unit_price(l.pricing, 'numbers_mobile') is not null
              then jsonb_build_object(
                     'feeMonthlyEur', pg_temp.unit_price(l.pricing, 'numbers_mobile'))
         end,
         'landline',
         case when pg_temp.unit_price(l.pricing, 'numbers_landline') is not null
              then jsonb_build_object(
                     'feeMonthlyEur', pg_temp.unit_price(l.pricing, 'numbers_landline'))
         end))
  from public.price_tiers l
 where l.id = coalesce(
         p.price_tier_id,
         (select id from public.price_tiers where is_default order by created_at limit 1));

-- --- data move 2: a customer keeps what they paid per number -------------------------
-- Until now: the customer's own unit price, else the list that applied to them
-- (own list → package list → standard list). Where that differs from the fee
-- their package now holds, it becomes the customer's own fee.
with before as (
  select s.id,
         kind.key as kind,
         coalesce(pg_temp.unit_price(s.pricing, kind.category),
                  pg_temp.unit_price(l.pricing, kind.category)) as old_fee,
         (p.numbers -> kind.key ->> 'feeMonthlyEur')::numeric as package_fee
    from public.org_subscriptions s
    join public.packages p on p.id = s.package_id
    left join public.price_tiers l
      on l.id = coalesce(
           s.price_tier_id,
           p.price_tier_id,
           (select id from public.price_tiers where is_default order by created_at limit 1))
   cross join (values ('mobile', 'numbers_mobile'),
                      ('landline', 'numbers_landline')) as kind(key, category)
),
own as (
  select id,
         jsonb_object_agg(kind, jsonb_build_object('feeMonthlyEur', old_fee)) as numbers
    from before
   where old_fee is not null
     and old_fee is distinct from package_fee
   group by id
)
update public.org_subscriptions s
   set numbers = own.numbers
  from own
 where own.id = s.id;

-- --- proof: nobody is charged a different fee per number than before -----------------
do $$
declare
  changed integer;
begin
  -- customers with a package: old fee (own price → list) vs. new fee (own fee → package)
  select count(*) into changed
    from public.org_subscriptions s
    join public.packages p on p.id = s.package_id
    left join public.price_tiers l
      on l.id = coalesce(
           s.price_tier_id,
           p.price_tier_id,
           (select id from public.price_tiers where is_default order by created_at limit 1))
   cross join (values ('mobile', 'numbers_mobile'),
                      ('landline', 'numbers_landline')) as kind(key, category)
   where coalesce(pg_temp.unit_price(s.pricing, kind.category),
                  pg_temp.unit_price(l.pricing, kind.category))
         is distinct from
         coalesce((s.numbers -> kind.key ->> 'feeMonthlyEur')::numeric,
                  (p.numbers -> kind.key ->> 'feeMonthlyEur')::numeric);
  if changed > 0 then
    raise exception
      '0043: % fee(s) per phone number would change for customers with a package', changed;
  end if;

  -- customers WITHOUT a package now pay the purchase cost for a number. That is
  -- only invoice-neutral while none of them has an active number that a price
  -- list priced until now.
  select count(*) into changed
    from public.phone_numbers n
    left join public.org_subscriptions s on s.org_id = n.org_id
    left join public.price_tiers l
      on l.id = coalesce(
           s.price_tier_id,
           (select id from public.price_tiers where is_default order by created_at limit 1))
   where n.status = 'active'
     and s.package_id is null
     and coalesce(
           pg_temp.unit_price(
             s.pricing,
             case when n.number_type = 'mobile' then 'numbers_mobile' else 'numbers_landline' end),
           pg_temp.unit_price(
             l.pricing,
             case when n.number_type = 'mobile' then 'numbers_mobile' else 'numbers_landline' end))
         is not null;
  if changed > 0 then
    raise exception
      '0043: % active phone number(s) belong to customers without a package; their fee would fall to the purchase cost. Assign a package first.',
      changed;
  end if;
end
$$;

drop function pg_temp.unit_price(jsonb, text);
