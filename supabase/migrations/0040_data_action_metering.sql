-- Zendori v2 — 0040: metering of data actions (billing position "Data Actions")
--
-- A price list can now carry a sell price per data action
-- (price_tiers.pricing.data_actions, packages/core/src/billing.ts). This
-- migration makes the quantity exact and durable:
--
--   · Every data action that reached the customer's system successfully and was
--     started by an agent writes ONE row into the append-only usage ledger
--     (usage_events, category 'data_action') — by a trigger on action_runs, in
--     the same transaction as the run's state change. That covers every writer
--     (inline agent calls, runs a team member confirmed, voice, imported MCP
--     tools) without any application code.
--   · Counted: state 'succeeded', trigger 'agent' | 'member'.
--     Not counted: test runs from the settings page, failed calls, rejected runs.
--   · The ledger row survives the run: deleting an action or a connection
--     removes its action_runs (0035 cascade) but not what was already billable.
--     dedup_key 'action:<run id>' makes a second count impossible.
--   · billing_org_rollup returns the new row 'data_actions' (quantity only —
--     there is no purchase cost: the call runs on the customer's own system).
--
-- The ledger stays content-free: ids, the action's label and the trigger kind —
-- never arguments or results (§7).
--
-- Rollout order: app first (the web app reads a missing 'data_actions' row as 0),
-- then this migration. The worker needs no change.

-- --- ledger: new category + provider ------------------------------------------------
alter table public.usage_events drop constraint usage_events_category_check;
alter table public.usage_events add constraint usage_events_category_check
  check (category in ('voice_minutes', 'index_embeddings', 'index_vision',
                      'whatsapp_message', 'email', 'sip_minutes', 'data_action', 'other'));

-- 'customer' = the org's own end system (no provider of ours is involved)
alter table public.usage_events drop constraint usage_events_provider_check;
alter table public.usage_events add constraint usage_events_provider_check
  check (provider in ('xai', 'twilio', 'openai', 'anthropic', 'resend', 'customer'));

-- --- metering trigger ---------------------------------------------------------------
create or replace function private.meter_action_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text;
begin
  -- kept in the ledger so the customer's usage log can still name the action
  -- after it was deleted
  select a.label into v_label from public.data_actions a where a.id = new.data_action_id;

  insert into public.usage_events
    (org_id, conversation_id, category, provider, quantity, unit, cost_usd,
     dedup_key, source_ref, metadata, occurred_at)
  values
    (new.org_id, new.conversation_id, 'data_action', 'customer', 1, 'action', 0,
     'action:' || new.id::text, new.id::text,
     jsonb_build_object('data_action_id', new.data_action_id, 'label', v_label,
                        'trigger', new.trigger),
     coalesce(new.finished_at, now()))
  on conflict do nothing;
  return new;
exception when others then
  -- The call to the customer's system has already happened when a run is marked
  -- succeeded. Failing that write would report a successful (possibly writing)
  -- action as failed — so a metering problem never fails the run (0036 pattern).
  return new;
end;
$$;

create trigger action_runs_meter_insert
  after insert on public.action_runs
  for each row
  when (new.state = 'succeeded' and new.trigger <> 'test')
  execute function private.meter_action_run();

-- the WHEN clause keeps the function off every other update of a run
create trigger action_runs_meter_update
  after update of state on public.action_runs
  for each row
  when (new.state = 'succeeded' and old.state is distinct from 'succeeded'
        and new.trigger <> 'test')
  execute function private.meter_action_run();

-- --- backfill: runs that succeeded before this migration ---------------------------
insert into public.usage_events
  (org_id, conversation_id, category, provider, quantity, unit, cost_usd,
   dedup_key, source_ref, metadata, occurred_at)
select r.org_id, r.conversation_id, 'data_action', 'customer', 1, 'action', 0,
       'action:' || r.id::text, r.id::text,
       jsonb_build_object('data_action_id', r.data_action_id, 'label', a.label,
                          'trigger', r.trigger),
       coalesce(r.finished_at, r.created_at)
from public.action_runs r
left join public.data_actions a on a.id = r.data_action_id
where r.state = 'succeeded' and r.trigger <> 'test'
on conflict do nothing;

-- --- rollup: one more row -----------------------------------------------------------
-- Identical to 0023 plus the last SELECT.
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
  union all
  -- Data actions: successful agent-triggered calls of the org's own system,
  -- metered by the trigger above. No purchase cost.
  select 'data_actions', coalesce(sum(ue.quantity), 0)::numeric, 0::numeric
    from usage_events ue
    where ue.org_id = p_org_id and ue.occurred_at >= p_from and ue.occurred_at < p_to
      and ue.category = 'data_action'
$$;

revoke all on function public.billing_org_rollup(uuid, timestamptz, timestamptz) from public;
revoke all on function public.billing_org_rollup(uuid, timestamptz, timestamptz) from anon;
revoke all on function public.billing_org_rollup(uuid, timestamptz, timestamptz) from authenticated;
grant execute on function public.billing_org_rollup(uuid, timestamptz, timestamptz) to service_role;
