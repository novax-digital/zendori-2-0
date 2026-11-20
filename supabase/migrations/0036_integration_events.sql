-- Zendori v2 — 0036: API-Integration, part 2 (Phase 13c) — outbound events
--
-- Zendori tells an org's own end system when something changes: a signed HTTP
-- POST ("webhook") per event to the URL configured on the API connection.
--   · api_connections.event_url / event_types   what goes where
--   · integration_events                        the outbox: one row per
--                                               (event, subscribed connection)
--   · triggers on tickets / conversations / contacts fill the outbox, so every
--     writer is covered (web app, worker, public API) without app code
--
-- Delivery is the worker's job (state pending → sent | failed, retries with a
-- backoff kept in next_attempt_at). Rows are content-free: they carry ids and
-- which fields changed; the worker reads the current record when it delivers.
--
-- Echo suppression (prepares Phase 13d): a change that arrives THROUGH the
-- public API of connection X is not reported back to X. The API route tags its
-- service-role requests with the header x-zendori-origin-connection; only the
-- service role is trusted to do so.
--
-- Safety: an outbox problem must never break a core write. The enqueue function
-- swallows its own errors — a lost event is acceptable, a failed message insert
-- is not.
--
-- Rollout order: app deploy first, then this migration (requires 0035).

alter table public.api_connections
  add column event_url text
    check (event_url is null or char_length(event_url) between 8 and 500),
  add column event_types text[] not null default '{}'::text[];

create table public.integration_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  connection_id uuid not null,
  -- e.g. ticket.created · ticket.updated · conversation.created ·
  -- conversation.updated · contact.updated · ping (INTEGRATION_EVENT_TYPES)
  event_type text not null,
  entity_type text not null check (entity_type in ('ticket', 'conversation', 'contact', 'ping')),
  entity_id uuid,
  -- content-free facts about the change: changed field names, old/new status
  details jsonb not null default '{}'::jsonb,
  state text not null default 'pending' check (state in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  -- when the worker may try (again); also the claim lease while a try runs
  next_attempt_at timestamptz not null default now(),
  last_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  foreign key (connection_id, org_id)
    references public.api_connections (id, org_id) on delete cascade
);

create index integration_events_due_idx
  on public.integration_events (next_attempt_at)
  where state = 'pending';
create index integration_events_connection_idx
  on public.integration_events (connection_id, created_at desc);

alter table public.integration_events enable row level security;

-- Delivery log on the connection page: owner/admin only, like the connection.
create policy integration_events_select on public.integration_events
  for select to authenticated using (private.is_org_owner(org_id));
-- No client write policies: triggers, the ping function and the worker write.

-- --- origin of the current request (echo suppression) ---------------------------
-- PostgREST exposes the request headers as the GUC request.headers. Only the
-- service role may name an origin; a signed-in member cannot hide a change from
-- an end system by sending the header. Direct connections (worker's pg-boss,
-- psql) have no headers → no origin.
create or replace function private.origin_connection_id()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_role text;
  v_raw text;
begin
  -- the role claim as PostgREST sets it (legacy per-claim GUC or the JSON claims)
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role');
  if v_role is distinct from 'service_role' then
    return null;
  end if;
  v_raw := nullif(current_setting('request.headers', true), '')::json
    ->> 'x-zendori-origin-connection';
  if v_raw is null or v_raw = '' then
    return null;
  end if;
  return v_raw::uuid;
exception when others then
  return null;
end;
$$;

-- --- outbox writer ----------------------------------------------------------------
create or replace function private.enqueue_integration_event(
  p_org_id uuid,
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_details jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_origin uuid;
begin
  -- cheap exit for the common case: the org has no event subscriptions at all
  if not exists (
    select 1 from public.api_connections c
    where c.org_id = p_org_id and c.is_active and c.event_url is not null
      and p_event_type = any (c.event_types)
  ) then
    return;
  end if;

  v_origin := private.origin_connection_id();
  insert into public.integration_events
    (org_id, connection_id, event_type, entity_type, entity_id, details)
  select c.org_id, c.id, p_event_type, p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb)
  from public.api_connections c
  where c.org_id = p_org_id
    and c.is_active
    and c.event_url is not null
    and p_event_type = any (c.event_types)
    and (v_origin is null or c.id <> v_origin);
exception when others then
  -- never fail the ticket / conversation / contact write because of an event
  null;
end;
$$;

-- --- triggers ---------------------------------------------------------------------
create or replace function private.emit_ticket_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}'::text[];
begin
  if tg_op = 'INSERT' then
    perform private.enqueue_integration_event(
      new.org_id, 'ticket.created', 'ticket', new.id,
      jsonb_build_object('origin', new.origin));
    return new;
  end if;
  if new.status is distinct from old.status then v_changed := array_append(v_changed, 'status'); end if;
  if new.priority is distinct from old.priority then v_changed := array_append(v_changed, 'priority'); end if;
  if new.assignee_id is distinct from old.assignee_id then v_changed := array_append(v_changed, 'assignee_id'); end if;
  if new.subject is distinct from old.subject then v_changed := array_append(v_changed, 'subject'); end if;
  if new.description is distinct from old.description then v_changed := array_append(v_changed, 'description'); end if;
  if new.category is distinct from old.category then v_changed := array_append(v_changed, 'category'); end if;
  if cardinality(v_changed) > 0 then
    perform private.enqueue_integration_event(
      new.org_id, 'ticket.updated', 'ticket', new.id,
      jsonb_build_object('changed', to_jsonb(v_changed))
        || case when new.status is distinct from old.status
             then jsonb_build_object('status_from', old.status, 'status_to', new.status)
             else '{}'::jsonb end);
  end if;
  return new;
end;
$$;

create trigger tickets_emit_integration_event
  after insert or update on public.tickets
  for each row execute function private.emit_ticket_event();

create or replace function private.emit_conversation_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}'::text[];
begin
  if tg_op = 'INSERT' then
    perform private.enqueue_integration_event(
      new.org_id, 'conversation.created', 'conversation', new.id, '{}'::jsonb);
    return new;
  end if;
  if new.status is distinct from old.status then v_changed := array_append(v_changed, 'status'); end if;
  if new.mode is distinct from old.mode then v_changed := array_append(v_changed, 'mode'); end if;
  if new.assignee_id is distinct from old.assignee_id then v_changed := array_append(v_changed, 'assignee_id'); end if;
  if new.contact_id is distinct from old.contact_id then v_changed := array_append(v_changed, 'contact_id'); end if;
  perform private.enqueue_integration_event(
    new.org_id, 'conversation.updated', 'conversation', new.id,
    jsonb_build_object('changed', to_jsonb(v_changed))
      || case when new.status is distinct from old.status
           then jsonb_build_object('status_from', old.status, 'status_to', new.status)
           else '{}'::jsonb end);
  return new;
end;
$$;

create trigger conversations_emit_integration_event_insert
  after insert on public.conversations
  for each row execute function private.emit_conversation_event();

-- conversations are updated on EVERY message (last_message_at): the WHEN clause
-- keeps the trigger function off that hot path entirely.
create trigger conversations_emit_integration_event_update
  after update on public.conversations
  for each row
  when (old.status is distinct from new.status
     or old.mode is distinct from new.mode
     or old.assignee_id is distinct from new.assignee_id
     or old.contact_id is distinct from new.contact_id)
  execute function private.emit_conversation_event();

create or replace function private.emit_contact_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}'::text[];
begin
  if new.name is distinct from old.name then v_changed := array_append(v_changed, 'name'); end if;
  if new.email is distinct from old.email then v_changed := array_append(v_changed, 'email'); end if;
  if new.phone is distinct from old.phone then v_changed := array_append(v_changed, 'phone'); end if;
  if new.company is distinct from old.company then v_changed := array_append(v_changed, 'company'); end if;
  perform private.enqueue_integration_event(
    new.org_id, 'contact.updated', 'contact', new.id,
    jsonb_build_object('changed', to_jsonb(v_changed)));
  return new;
end;
$$;

create trigger contacts_emit_integration_event
  after update on public.contacts
  for each row
  when (old.name is distinct from new.name
     or old.email is distinct from new.email
     or old.phone is distinct from new.phone
     or old.company is distinct from new.company)
  execute function private.emit_contact_event();

-- --- test event from the settings page ---------------------------------------------
-- Owner/admin queues a "ping" for one connection (regardless of its event_types),
-- so the endpoint and the signature check can be verified without real data.
create or replace function public.request_integration_ping(p_connection_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_url text;
  v_event uuid;
begin
  select c.org_id, c.event_url into v_org, v_url
  from public.api_connections c where c.id = p_connection_id;
  if v_org is null or not private.is_org_owner(v_org) then
    raise exception 'not allowed';
  end if;
  if v_url is null then
    raise exception 'no event url configured';
  end if;
  insert into public.integration_events (org_id, connection_id, event_type, entity_type, details)
  values (v_org, p_connection_id, 'ping', 'ping', '{}'::jsonb)
  returning id into v_event;
  return v_event;
end;
$$;
revoke all on function public.request_integration_ping(uuid) from public;
revoke all on function public.request_integration_ping(uuid) from anon;
grant execute on function public.request_integration_ping(uuid) to authenticated;
