-- Zendori v2 — 0023: configurable phone-number monthly costs by type
--
-- Splits the single "Rufnummern" billing category into mobile vs. landline
-- (Festnetz = local + national) so the operator can set the monthly PURCHASE
-- cost per number type, and price each type separately. Counts come from the
-- phone_numbers registry (0016, number_type), not from a channel proxy.

-- Editable monthly purchase cost per number type, in EUR (what a number costs us
-- from the provider). Basis for the recommendation and the customer price.
alter table public.billing_settings
  add column if not exists number_cost_mobile_eur numeric not null default 3.0
    check (number_cost_mobile_eur >= 0),
  add column if not exists number_cost_landline_eur numeric not null default 1.5
    check (number_cost_landline_eur >= 0);

-- Replace billing_org_rollup: the old 'numbers_count' (active voice/whatsapp
-- channels) becomes two type-split counts from the phone_numbers inventory.
create or replace function public.billing_org_rollup(
  p_org_id uuid,
  p_from timestamptz,
  p_to timestamptz
) returns table (category text, quantity numeric, cost_usd numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select 'ai'::text, count(*)::numeric, coalesce(sum(ar.cost_usd), 0)::numeric
    from ai_runs ar
    where ar.org_id = p_org_id and ar.created_at >= p_from and ar.created_at < p_to
      and ar.step in ('classify', 'extract', 'draft', 'rerank', 'learn')
  union all
  select 'embeddings',
    (select count(*) from ai_runs where org_id = p_org_id and created_at >= p_from
       and created_at < p_to and step = 'retrieve')
      + (select count(*) from usage_events where org_id = p_org_id and occurred_at >= p_from
           and occurred_at < p_to and category = 'index_embeddings'),
    (select coalesce(sum(cost_usd), 0) from ai_runs where org_id = p_org_id and created_at >= p_from
       and created_at < p_to and step = 'retrieve')
      + (select coalesce(sum(cost_usd), 0) from usage_events where org_id = p_org_id
           and occurred_at >= p_from and occurred_at < p_to and category = 'index_embeddings')
  union all
  select 'transcription', count(*)::numeric, coalesce(sum(ar.cost_usd), 0)::numeric
    from ai_runs ar
    where ar.org_id = p_org_id and ar.created_at >= p_from and ar.created_at < p_to
      and ar.step = 'transcribe'
  union all
  select 'voice', coalesce(sum(ue.quantity), 0)::numeric, coalesce(sum(ue.cost_usd), 0)::numeric
    from usage_events ue
    where ue.org_id = p_org_id and ue.occurred_at >= p_from and ue.occurred_at < p_to
      and ue.category = 'voice_minutes'
  union all
  select 'whatsapp_count',
    (select count(*) from messages m join channels c on c.id = m.channel_id
       where m.org_id = p_org_id and m.created_at >= p_from and m.created_at < p_to
         and c.type = 'whatsapp' and m.direction = 'out')::numeric,
    0::numeric
  union all
  select 'email_count',
    (select count(*) from messages m join channels c on c.id = m.channel_id
       where m.org_id = p_org_id and m.created_at >= p_from and m.created_at < p_to
         and c.type = 'email' and m.direction = 'out')::numeric,
    0::numeric
  union all
  -- Active mobile numbers from the inventory (snapshot; prorated in TS)
  select 'numbers_mobile_count',
    (select count(*) from phone_numbers
       where org_id = p_org_id and status = 'active' and number_type = 'mobile')::numeric,
    0::numeric
  union all
  -- Active landline numbers = local + national
  select 'numbers_landline_count',
    (select count(*) from phone_numbers
       where org_id = p_org_id and status = 'active' and number_type in ('local', 'national'))::numeric,
    0::numeric
$$;

revoke all on function public.billing_org_rollup(uuid, timestamptz, timestamptz) from public;
revoke all on function public.billing_org_rollup(uuid, timestamptz, timestamptz) from anon;
revoke all on function public.billing_org_rollup(uuid, timestamptz, timestamptz) from authenticated;
grant execute on function public.billing_org_rollup(uuid, timestamptz, timestamptz) to service_role;
