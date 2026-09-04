-- ============================================================================
-- Tickets (Phase 11, owner decision 2026-09-04)
--
-- A ticket is a WORK ITEM created from a conversation: the conversation keeps
-- flowing in the inbox, the ticket owns status / priority / assignee / HubSpot
-- state and a human-readable, per-org configurable id. One conversation can
-- have many tickets over time; while a non-resolved one exists, new qualifying
-- events ATTACH to it (partial unique index below) — after resolve, the next
-- event opens a fresh ticket.
--
-- Numbering: ticket_counters holds one row per org, written ONLY through
-- allocate_ticket_number() (row lock serializes concurrent callers). The
-- BEFORE INSERT trigger assigns number + display_id inside the insert's own
-- transaction, so a lost race on the open-per-conversation index rolls the
-- counter back too (no gaps from races). display_id is rendered ONCE from
-- org_settings.ticket_id_format and frozen — changing the format later only
-- affects new tickets.
--
-- RLS (0019 pattern): members read/insert/update, owners (incl. admins since
-- 0024) delete; identity columns and the worker-owned HubSpot state are
-- guarded by the trigger. ticket_events is the content-free timeline.
--
-- Rollout: apply BEFORE deploying the code (worker/web tolerate the missing
-- table and stay silent until then).
-- ============================================================================

-- composite-FK target (0020 pattern; contacts had none yet)
alter table public.contacts add constraint contacts_id_org_unique unique (id, org_id);

-- --- org-level numbering settings ---------------------------------------------
alter table public.org_settings
  add column ticket_id_format text not null default '#{N}'
    constraint org_settings_ticket_id_format_check
    check (length(ticket_id_format) between 1 and 40 and ticket_id_format ~ '\{N+\}'),
  add column ticket_number_start integer not null default 1
    constraint org_settings_ticket_number_start_check check (ticket_number_start >= 1);

-- --- counter ----------------------------------------------------------------
create table public.ticket_counters (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  last_number bigint not null,
  updated_at timestamptz not null default now()
);
alter table public.ticket_counters enable row level security;
create policy ticket_counters_select on public.ticket_counters
  for select to authenticated using (private.is_org_member(org_id));
-- no client write policies: the function below is the only writer

create or replace function public.allocate_ticket_number(p_org_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number bigint;
begin
  -- service role (auth.uid() null) is trusted; members only for their own org
  if (select auth.uid()) is not null and not private.is_org_member(p_org_id) then
    raise exception 'not a member of this organization';
  end if;
  insert into public.ticket_counters as c (org_id, last_number)
  values (
    p_org_id,
    coalesce((select s.ticket_number_start from public.org_settings s where s.org_id = p_org_id), 1)
  )
  on conflict (org_id) do update
    set last_number = c.last_number + 1, updated_at = now()
  returning c.last_number into v_number;
  return v_number;
end;
$$;
revoke all on function public.allocate_ticket_number(uuid) from public;
grant execute on function public.allocate_ticket_number(uuid) to authenticated, service_role;

-- Tokens: {N} plain · {NNNN…} zero-padded to the token length (never truncated)
-- · {YYYY} · {YY}; the year is taken in Europe/Berlin. Must stay token-for-token
-- identical to formatTicketId() in packages/core/src/tickets.ts (RLS test pins it).
create or replace function private.render_ticket_display_id(p_format text, p_number bigint, p_at timestamptz)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_out text := p_format;
  v_tok text;
  v_local timestamp := timezone('Europe/Berlin', p_at);
begin
  for v_tok in select distinct m[1] from regexp_matches(p_format, '\{(N+|YYYY|YY)\}', 'g') m loop
    v_out := replace(v_out, '{' || v_tok || '}',
      case v_tok
        when 'YYYY' then to_char(v_local, 'YYYY')
        when 'YY' then to_char(v_local, 'YY')
        else case
          when length(p_number::text) >= length(v_tok) then p_number::text
          else lpad(p_number::text, length(v_tok), '0')
        end
      end);
  end loop;
  return v_out;
end;
$$;

-- --- tickets ----------------------------------------------------------------
create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  conversation_id uuid not null,
  channel_id uuid not null,
  contact_id uuid,
  number bigint not null,
  display_id text not null,
  subject text,
  description text,
  category text,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'waiting', 'resolved')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  assignee_id uuid references auth.users (id) on delete set null,
  origin text not null
    check (origin in ('handoff', 'intake', 'suppressed', 'no_agent', 'draft_only',
      'pipeline_failure', 'voice', 'form', 'manual', 'takeover')),
  opened_message_id uuid,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  -- HubSpot state mirrored from 0007 / external_refs so Phase 11b can sync tickets
  hubspot_ticket_id text,
  hubspot_sync_requested_at timestamptz,
  hubspot_synced_at timestamptz,
  hubspot_noted_through timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tickets_id_org_unique unique (id, org_id),
  constraint tickets_conversation_fk foreign key (conversation_id, org_id)
    references public.conversations (id, org_id) on delete cascade,
  constraint tickets_channel_fk foreign key (channel_id, org_id)
    references public.channels (id, org_id) on delete cascade,
  constraint tickets_contact_fk foreign key (contact_id, org_id)
    references public.contacts (id, org_id) on delete set null (contact_id),
  constraint tickets_opened_message_fk foreign key (opened_message_id, org_id)
    references public.messages (id, org_id) on delete set null (opened_message_id)
);
create unique index tickets_org_number_unique on public.tickets (org_id, number);
create unique index tickets_org_display_id_unique on public.tickets (org_id, display_id);
-- THE attach invariant: at most one non-resolved ticket per conversation
create unique index tickets_open_per_conversation_idx on public.tickets (conversation_id)
  where status <> 'resolved';
create index tickets_conversation_idx on public.tickets (conversation_id, opened_at desc);
create index tickets_org_status_idx on public.tickets (org_id, status, updated_at desc);
create index tickets_org_assignee_idx on public.tickets (org_id, assignee_id)
  where assignee_id is not null;
create index tickets_hubspot_sync_due_idx on public.tickets (hubspot_sync_requested_at)
  where hubspot_sync_requested_at is not null;

alter table public.tickets enable row level security;
create policy tickets_select on public.tickets
  for select to authenticated using (private.is_org_member(org_id));
create policy tickets_insert on public.tickets
  for insert to authenticated with check (private.is_org_member(org_id));
create policy tickets_update on public.tickets
  for update to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));
create policy tickets_delete on public.tickets
  for delete to authenticated using (private.is_org_owner(org_id));

-- Identity + bookkeeping guard. The service role (auth.uid() null) may set
-- everything; authenticated callers get number/display_id assigned and cannot
-- touch identity columns or the worker-owned HubSpot state afterwards.
create or replace function private.prepare_ticket_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv record;
  v_format text;
  v_is_client boolean := (select auth.uid()) is not null;
begin
  if tg_op = 'INSERT' then
    if v_is_client and (new.number is not null or new.display_id is not null) then
      raise exception 'ticket number and display id are assigned by the system';
    end if;
    select c.channel_id, c.contact_id into v_conv
    from public.conversations c
    where c.id = new.conversation_id and c.org_id = new.org_id;
    if not found then
      raise exception 'conversation not found in this organization';
    end if;
    new.channel_id := coalesce(new.channel_id, v_conv.channel_id);
    new.contact_id := coalesce(new.contact_id, v_conv.contact_id);
    if new.opened_at is null then
      new.opened_at := now();
    end if;
    if new.number is null then
      new.number := public.allocate_ticket_number(new.org_id);
    end if;
    if new.display_id is null then
      select s.ticket_id_format into v_format from public.org_settings s where s.org_id = new.org_id;
      new.display_id := private.render_ticket_display_id(coalesce(v_format, '#{N}'), new.number, new.opened_at);
    end if;
    if new.status = 'resolved' then
      new.resolved_at := coalesce(new.resolved_at, now());
    end if;
    return new;
  end if;

  if v_is_client then
    if new.org_id is distinct from old.org_id
       or new.conversation_id is distinct from old.conversation_id
       or new.channel_id is distinct from old.channel_id
       or new.number is distinct from old.number
       or new.display_id is distinct from old.display_id
       or new.origin is distinct from old.origin
       or new.opened_message_id is distinct from old.opened_message_id
       or new.opened_at is distinct from old.opened_at
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'ticket identity columns are immutable';
    end if;
    if new.hubspot_ticket_id is distinct from old.hubspot_ticket_id
       or new.hubspot_synced_at is distinct from old.hubspot_synced_at
       or new.hubspot_noted_through is distinct from old.hubspot_noted_through then
      raise exception 'hubspot sync state is written by the worker only';
    end if;
  end if;
  if new.status = 'resolved' and old.status <> 'resolved' then
    new.resolved_at := now();
  elsif new.status <> 'resolved' then
    new.resolved_at := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger tickets_prepare_row
  before insert or update on public.tickets
  for each row execute function private.prepare_ticket_row();

-- --- timeline ------------------------------------------------------------------
create table public.ticket_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  ticket_id uuid not null,
  kind text not null
    check (kind in ('created', 'attached', 'status_changed', 'assigned', 'hubspot_synced', 'note')),
  actor_id uuid references auth.users (id) on delete set null,
  -- content-free by contract (§7): ids, origins, statuses — never message text
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ticket_events_ticket_fk foreign key (ticket_id, org_id)
    references public.tickets (id, org_id) on delete cascade
);
create index ticket_events_ticket_idx on public.ticket_events (ticket_id, created_at);
alter table public.ticket_events enable row level security;
create policy ticket_events_select on public.ticket_events
  for select to authenticated using (private.is_org_member(org_id));
create policy ticket_events_insert on public.ticket_events
  for insert to authenticated with check (private.is_org_member(org_id));
-- no client update/delete

create or replace function private.log_ticket_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.ticket_events (org_id, ticket_id, kind, actor_id, details)
    values (new.org_id, new.id, 'created', new.created_by, jsonb_build_object('origin', new.origin));
    return new;
  end if;
  if new.status is distinct from old.status then
    insert into public.ticket_events (org_id, ticket_id, kind, actor_id, details)
    values (new.org_id, new.id, 'status_changed', (select auth.uid()),
            jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    insert into public.ticket_events (org_id, ticket_id, kind, actor_id, details)
    values (new.org_id, new.id, 'assigned', (select auth.uid()),
            jsonb_build_object('assignee_id', new.assignee_id));
  end if;
  return new;
end;
$$;
create trigger tickets_log_event
  after insert or update on public.tickets
  for each row execute function private.log_ticket_event();

-- --- realtime (0001 pattern) ------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.tickets;
  end if;
end;
$$;

-- --- permissions backfill (0024 lesson: never lock existing Mitarbeiter out) ----
-- The new 'tickets' area follows the member's inbox level.
update public.org_members
set permissions = jsonb_set(permissions, '{areas,tickets}', permissions #> '{areas,inbox}', true)
where role = 'agent'
  and jsonb_typeof(permissions -> 'areas') = 'object'
  and permissions -> 'areas' ? 'inbox'
  and not (permissions -> 'areas' ? 'tickets');
update public.invites
set permissions = jsonb_set(permissions, '{areas,tickets}', permissions #> '{areas,inbox}', true)
where role = 'agent'
  and jsonb_typeof(permissions -> 'areas') = 'object'
  and permissions -> 'areas' ? 'inbox'
  and not (permissions -> 'areas' ? 'tickets');

-- --- search (0028 pattern: SECURITY INVOKER, escaped ILIKE) -----------------------
create or replace function public.search_tickets(
  p_org_id uuid,
  p_query text,
  p_statuses text[] default null,
  p_channel_ids uuid[] default null,
  p_limit integer default 100
)
returns table (id uuid)
language sql
stable
set search_path = public
as $$
  with needle as (
    select
      '%'
      || replace(replace(replace(trim(coalesce(p_query, '')), '\', '\\'), '%', '\%'), '_', '\_')
      || '%' as pat
  )
  select t.id
  from tickets t
  left join contacts ct on ct.id = t.contact_id and ct.org_id = t.org_id
  cross join needle n
  where t.org_id = p_org_id
    and length(trim(coalesce(p_query, ''))) > 0
    and (p_statuses is null or t.status = any (p_statuses))
    and (p_channel_ids is null or t.channel_id = any (p_channel_ids))
    and (
      t.display_id ilike n.pat
      or t.subject ilike n.pat
      or t.description ilike n.pat
      or ct.name ilike n.pat
      or ct.email ilike n.pat
      or ct.phone ilike n.pat
      or ct.company ilike n.pat
    )
  order by t.updated_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 100);
$$;
