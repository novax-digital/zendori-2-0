-- Zendori v2 — 0045: the fee per channel is charged for ACTIVE channels only
--
-- Owner decision 2026-11-26: until now a package charged "number of channels ×
-- fee" for what the package ALLOWED — a customer with WhatsApp in the package
-- paid for it without ever connecting WhatsApp. From now on a channel costs its
-- monthly fee only while it is active (channels.is_active). An inactive channel
-- is a draft: it can be set up in peace, receives nothing and costs nothing.
--
-- Rule: a channel is charged for every month in which it was active — the whole
-- month, no proration by days (otherwise it could be switched off shortly
-- before the end of each month). A slip is forgiven: a period that was ended
-- again within one hour does not count.
--
-- The database only knew the CURRENT state of a channel. This migration adds
-- the history the rule needs:
--
--   channel_active_periods   one row per stretch of time a channel was active
--                            (org, channel, kind, active_from, active_until)
--   billing_active_channels  (org, from, to) → channels per kind that were
--                            active in that span
--
-- A trigger on channels keeps the periods: activating opens one, deactivating
-- or deleting the channel closes it. channel_id deliberately has NO foreign
-- key — the period must outlive a deleted channel, the month is still charged.
-- With the organization everything goes (org.purge, §7).
--
-- Backfill: every channel that is active now gets a period that starts when the
-- channel was created (nothing better is known). Channels of kind 'test' are
-- never recorded; they are not part of any package.
--
-- Service role only, like every billing table (0022): RLS on, no policies.
--
-- Rollout order: this migration FIRST, then the app. The running code does not
-- know the table and keeps charging by quota; the new code charges by active
-- channels once the function exists, and by quota (as before) without it.

create table public.channel_active_periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  -- no FK on purpose: the period survives the channel's deletion
  channel_id uuid not null,
  channel_kind text not null
    check (channel_kind in ('form', 'email', 'whatsapp', 'voice', 'chat')),
  active_from timestamptz not null default now(),
  -- null = still active
  active_until timestamptz,
  created_at timestamptz not null default now(),
  check (active_until is null or active_until >= active_from)
);

-- at most one open period per channel
create unique index channel_active_periods_open_idx
  on public.channel_active_periods (channel_id)
  where active_until is null;
create index channel_active_periods_org_idx
  on public.channel_active_periods (org_id, active_from);

alter table public.channel_active_periods enable row level security;
-- no policies: readable and writable by the service role only

-- --- keep the periods ----------------------------------------------------------------
create or replace function private.track_channel_active_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_kind text;
  v_new_kind text;
  v_old_on boolean := false;
  v_new_on boolean := false;
begin
  if tg_op <> 'INSERT' then
    v_old_kind := private.channel_kind(old.type, old.config);
    v_old_on := old.is_active and v_old_kind <> 'test';
  end if;
  if tg_op <> 'DELETE' then
    v_new_kind := private.channel_kind(new.type, new.config);
    v_new_on := new.is_active and v_new_kind <> 'test';
  end if;

  -- deactivated, deleted, or the kind changed: the running period ends
  if v_old_on and (not v_new_on or v_old_kind <> v_new_kind) then
    update public.channel_active_periods
       set active_until = now()
     where channel_id = old.id
       and active_until is null;
  end if;
  -- activated, created active, or the kind changed: a new period begins
  if v_new_on and (not v_old_on or v_old_kind <> v_new_kind) then
    insert into public.channel_active_periods (org_id, channel_id, channel_kind)
    values (new.org_id, new.id, v_new_kind);
  end if;
  return null;
end;
$$;

create trigger channels_track_active_period
  after insert or delete or update of is_active, type, config on public.channels
  for each row execute function private.track_channel_active_period();

-- --- backfill: what is active now has been active since it was created --------------
insert into public.channel_active_periods (org_id, channel_id, channel_kind, active_from)
select c.org_id, c.id, private.channel_kind(c.type, c.config), c.created_at
  from public.channels c
 where c.is_active
   and private.channel_kind(c.type, c.config) <> 'test';

-- --- how many channels of each kind were active in a span ---------------------------
-- A period counts when it touches [p_from, p_to). One that was ended again
-- within an hour is treated as a slip and does not count.
create or replace function public.billing_active_channels(
  p_org_id uuid,
  p_from timestamptz,
  p_to timestamptz
) returns table (channel_kind text, quantity integer)
language sql
stable
security invoker
set search_path = public
as $$
  select p.channel_kind, count(distinct p.channel_id)::integer
    from channel_active_periods p
   where p.org_id = p_org_id
     and p.active_from < p_to
     and (p.active_until is null or p.active_until > p_from)
     and (p.active_until is null or p.active_until - p.active_from >= interval '1 hour')
   group by p.channel_kind;
$$;

revoke all on function public.billing_active_channels(uuid, timestamptz, timestamptz) from public;
revoke all on function public.billing_active_channels(uuid, timestamptz, timestamptz) from anon;
revoke all on function public.billing_active_channels(uuid, timestamptz, timestamptz) from authenticated;
grant execute on function public.billing_active_channels(uuid, timestamptz, timestamptz) to service_role;
