-- ============================================================================
-- Per-customer channel quotas (owner decision 2026-07-21)
--
-- The platform admin sets how many channels of each KIND a customer may have
-- (e.g. 0 Formular, 2 E-Mail, 3 WhatsApp, 1 Voice). Kind is the UI notion, not
-- the raw type: email splits into 'form' (contact-form intake) and 'email'
-- (forwarded mailbox / imap), chat splits into 'chat' (widget) and 'test'.
--
-- NO row for a kind = unlimited (today's behavior stays the default; quotas are
-- an opt-in restriction per customer). max_count = 0 locks the kind entirely.
-- Enforced app-side (friendly German errors) AND by a BEFORE INSERT OR UPDATE
-- trigger as the backstop — UPDATE too, because kind derives from freely
-- mutable columns (type/config) and a kind-flip must not bypass the quota.
-- Counting ALL existing rows of the kind (not just active ones), so
-- create-then-deactivate cannot hoard capacity. An advisory xact lock per
-- (org, kind) serializes concurrent inserts — a plain count under READ
-- COMMITTED would let two simultaneous inserts both pass.
-- ============================================================================

create table public.org_channel_limits (
  org_id uuid not null references public.organizations (id) on delete cascade,
  channel_kind text not null
    check (channel_kind in ('form', 'email', 'whatsapp', 'voice', 'chat', 'test')),
  max_count integer not null check (max_count >= 0),
  created_at timestamptz not null default now(),
  primary key (org_id, channel_kind)
);

alter table public.org_channel_limits enable row level security;

-- members read their quotas (settings UI shows "N von M belegt");
-- writes are service-role only (platform admin area) — no client policies.
create policy org_channel_limits_select on public.org_channel_limits
  for select to authenticated using (private.is_org_member(org_id));

-- --- kind mapping + enforcement --------------------------------------------------

-- Kind mapping — must mirror channelKindOf() in apps/web/src/lib/channel-limits.ts
-- EXACTLY. The jsonb_typeof guard makes the 'test' check both cast-safe (a
-- malformed config like {"test":"yes"} must not error every quota check in the
-- org) and strictly boolean, matching the TS `config.test === true`.
create or replace function private.channel_kind(p_type text, p_config jsonb)
returns text
language sql
immutable
as $$
  select case
    when p_type = 'email' then
      case
        when p_config->>'mode' = 'imap' then 'email'
        when coalesce(p_config->>'purpose', 'form') = 'forwarded_email' then 'email'
        else 'form'
      end
    when p_type = 'chat' then
      case
        when jsonb_typeof(p_config->'test') = 'boolean' and (p_config->>'test')::boolean
          then 'test'
        else 'chat'
      end
    else p_type
  end;
$$;

create or replace function private.enforce_channel_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_limit integer;
  v_count integer;
begin
  v_kind := private.channel_kind(new.type, new.config);
  -- UPDATE only matters when the derived kind actually changes.
  if tg_op = 'UPDATE'
     and private.channel_kind(old.type, old.config) = v_kind then
    return new;
  end if;
  select max_count into v_limit
  from public.org_channel_limits
  where org_id = new.org_id and channel_kind = v_kind;
  if v_limit is null then
    return new; -- no limit configured for this kind
  end if;
  -- Serialize concurrent quota checks for this (org, kind): the second insert
  -- blocks here until the first commits, so its count sees the committed row.
  perform pg_advisory_xact_lock(
    hashtextextended('channel_limit:' || new.org_id::text || ':' || v_kind, 0)
  );
  select count(*) into v_count
  from public.channels c
  where c.org_id = new.org_id
    and private.channel_kind(c.type, c.config) = v_kind
    and (tg_op = 'INSERT' or c.id <> new.id);
  if v_count >= v_limit then
    raise exception 'channel limit reached for kind % (max %)', v_kind, v_limit;
  end if;
  return new;
end;
$$;

create trigger channels_enforce_limit
  before insert or update of type, config on public.channels
  for each row execute function private.enforce_channel_limit();
