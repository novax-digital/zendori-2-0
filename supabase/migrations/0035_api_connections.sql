-- Zendori v2 — 0035: API-Integration, part 1 (Phase 13a + 13b)
--
-- Lets an org connect its OWN end systems and expose single HTTP calls to its
-- AI agents as "data actions" (agent tools):
--   · api_connections      one end system: base URL + encrypted credentials
--   · data_actions         one callable endpoint: method, path, parameters,
--                          response allowlist, read|write, confirmation switch
--   · agent_data_actions   n:m — which agent may use which action (0012 pattern)
--   · action_runs          every execution: who triggered it, the values sent,
--                          the mapped result, HTTP status and latency
--
-- All outbound calls are made by the WORKER (fixed egress IP, §12): the web app
-- only writes rows. A test run and an approved run are a row in state 'queued'
-- that the worker picks up; agent-triggered runs execute inline in the worker.
--
-- Rollout order: app deploy first (web and worker tolerate the missing tables:
-- 42P01 / PGRST205 = feature not available yet), then apply this migration.
-- HubSpot (`integrations`) is deliberately untouched.

-- --- connections ----------------------------------------------------------------
create table public.api_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  base_url text not null check (char_length(base_url) between 8 and 500),
  -- zod-validated at the app boundary (apiConnectionConfigSchema): auth kind +
  -- encrypted secret, encrypted signing secret. Never plaintext secrets (§7).
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- composite target so actions can prove same-org linkage via FK
  unique (id, org_id)
);

create index api_connections_org_idx on public.api_connections (org_id);

alter table public.api_connections enable row level security;

-- Credentials + the power to call a customer system: owner/admin only, reads
-- included (config holds ciphertext — plain members have no business with it).
create policy api_connections_select on public.api_connections
  for select to authenticated using (private.is_org_owner(org_id));
create policy api_connections_insert on public.api_connections
  for insert to authenticated with check (private.is_org_owner(org_id));
create policy api_connections_update on public.api_connections
  for update to authenticated
  using (private.is_org_owner(org_id))
  with check (private.is_org_owner(org_id));
create policy api_connections_delete on public.api_connections
  for delete to authenticated using (private.is_org_owner(org_id));

-- --- data actions ---------------------------------------------------------------
create table public.data_actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  connection_id uuid not null,
  -- tool name the model calls; unique per org, never a built-in tool name
  name text not null
    check (name ~ '^[a-z][a-z0-9_]{2,39}$'
      and name not in ('kb_search', 'create_ticket', 'handoff_human', 'end_call')),
  label text not null check (char_length(label) between 2 and 80),
  -- model-facing: what the action does and when to use it
  description text not null check (char_length(description) between 10 and 1000),
  kind text not null check (kind in ('read', 'write')),
  method text not null check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  path text not null check (char_length(path) between 1 and 500),
  -- zod-validated (dataActionParametersSchema / dataActionResponseFieldsSchema)
  parameters jsonb not null default '[]'::jsonb,
  response_fields jsonb not null default '[]'::jsonb,
  -- write actions only: a team member must confirm in the inbox before the call
  requires_confirmation boolean not null default false,
  timeout_ms integer not null default 8000 check (timeout_ms between 1000 and 20000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, name),
  foreign key (connection_id, org_id)
    references public.api_connections (id, org_id) on delete cascade
);

create index data_actions_connection_idx on public.data_actions (connection_id);

alter table public.data_actions enable row level security;

-- Members read (the inbox shows the action label next to a run, the agent
-- editor lists them read-only); defining what an agent may call is owner-only.
create policy data_actions_select on public.data_actions
  for select to authenticated using (private.is_org_member(org_id));
create policy data_actions_insert on public.data_actions
  for insert to authenticated with check (private.is_org_owner(org_id));
create policy data_actions_update on public.data_actions
  for update to authenticated
  using (private.is_org_owner(org_id))
  with check (private.is_org_owner(org_id));
create policy data_actions_delete on public.data_actions
  for delete to authenticated using (private.is_org_owner(org_id));

-- --- agent ↔ data action links (n:m) ---------------------------------------------
create table public.agent_data_actions (
  org_id uuid not null,
  agent_id uuid not null,
  data_action_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (agent_id, data_action_id),
  foreign key (agent_id, org_id)
    references public.agents (id, org_id) on delete cascade,
  foreign key (data_action_id, org_id)
    references public.data_actions (id, org_id) on delete cascade
);

create index agent_data_actions_org_idx on public.agent_data_actions (org_id);
create index agent_data_actions_action_idx on public.agent_data_actions (data_action_id);

alter table public.agent_data_actions enable row level security;

-- Linking decides what an agent can DO → owner-only writes, member reads
-- (mirrors agent_knowledge_bases).
create policy agent_data_actions_select on public.agent_data_actions
  for select to authenticated using (private.is_org_member(org_id));
create policy agent_data_actions_insert on public.agent_data_actions
  for insert to authenticated with check (private.is_org_owner(org_id));
create policy agent_data_actions_delete on public.agent_data_actions
  for delete to authenticated using (private.is_org_owner(org_id));

-- --- action runs ----------------------------------------------------------------
create table public.action_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  data_action_id uuid not null,
  conversation_id uuid,
  message_id uuid,
  agent_id uuid references public.agents (id) on delete set null,
  -- agent = called by the AI agent · member = reserved for manual triggers ·
  -- test = "Testlauf" from the settings page
  trigger text not null check (trigger in ('agent', 'member', 'test')),
  -- pending_approval → queued (approved) | rejected
  -- queued → running → succeeded | failed          (worker)
  state text not null
    check (state in ('pending_approval', 'queued', 'running', 'succeeded', 'failed', 'rejected')),
  -- the resolved values sent to the end system (agent + context parameters)
  args jsonb not null default '{}'::jsonb,
  -- mapped response (allowlisted fields, size-capped) — never the raw body
  result jsonb,
  http_status integer,
  latency_ms integer,
  error_code text,
  requested_by uuid references auth.users (id) on delete set null,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  -- set when the worker starts the HTTP call (stale-run sweep keys on it)
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (data_action_id, org_id)
    references public.data_actions (id, org_id) on delete cascade,
  foreign key (conversation_id, org_id)
    references public.conversations (id, org_id) on delete cascade
);

create index action_runs_conversation_idx
  on public.action_runs (conversation_id, created_at desc)
  where conversation_id is not null;
create index action_runs_action_idx on public.action_runs (data_action_id, created_at desc);
-- per-org rate cap + worker scan
create index action_runs_org_created_idx on public.action_runs (org_id, created_at desc);
create index action_runs_queued_idx on public.action_runs (created_at) where state = 'queued';

alter table public.action_runs enable row level security;

create policy action_runs_select on public.action_runs
  for select to authenticated using (private.is_org_member(org_id));
-- No client write policies: rows are written by the worker (service role) and
-- by the two functions below, which are the only client entry points.

-- Test run from the settings page: owner/admin queues a run with explicit values.
create or replace function public.request_action_test(p_action_id uuid, p_args jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_run uuid;
begin
  select a.org_id into v_org from public.data_actions a where a.id = p_action_id;
  if v_org is null or not private.is_org_owner(v_org) then
    raise exception 'not allowed';
  end if;
  if jsonb_typeof(coalesce(p_args, '{}'::jsonb)) <> 'object' then
    raise exception 'args must be an object';
  end if;
  insert into public.action_runs (org_id, data_action_id, trigger, state, args, requested_by)
  values (v_org, p_action_id, 'test', 'queued', coalesce(p_args, '{}'::jsonb), (select auth.uid()))
  returning id into v_run;
  return v_run;
end;
$$;
revoke all on function public.request_action_test(uuid, jsonb) from public;
revoke all on function public.request_action_test(uuid, jsonb) from anon;
grant execute on function public.request_action_test(uuid, jsonb) to authenticated;

-- Inbox decision on a run that waits for confirmation: an org member approves
-- (→ queued, the worker executes it) or rejects. Atomic: a run is decided once.
-- Returns the new state, or NULL when the run was already decided / is unknown.
create or replace function public.decide_action_run(p_run_id uuid, p_approve boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_state text;
begin
  select r.org_id into v_org from public.action_runs r where r.id = p_run_id;
  if v_org is null or not private.is_org_member(v_org) then
    raise exception 'not allowed';
  end if;
  update public.action_runs r
     set state = case when p_approve then 'queued' else 'rejected' end,
         decided_by = (select auth.uid()),
         decided_at = now(),
         finished_at = case when p_approve then null else now() end
   where r.id = p_run_id and r.state = 'pending_approval'
  returning r.state into v_state;
  return v_state;
end;
$$;
revoke all on function public.decide_action_run(uuid, boolean) from public;
revoke all on function public.decide_action_run(uuid, boolean) from anon;
grant execute on function public.decide_action_run(uuid, boolean) to authenticated;

-- --- tickets: a run waiting for confirmation is work for a human → ticket ---------
-- New origin 'action' (TICKET_ORIGINS in packages/core/src/tickets.ts). The 0030
-- check was declared inline, so it carries the generated name.
alter table public.tickets drop constraint if exists tickets_origin_check;
alter table public.tickets add constraint tickets_origin_check
  check (origin in ('handoff', 'intake', 'suppressed', 'no_agent', 'draft_only',
    'pipeline_failure', 'voice', 'form', 'manual', 'takeover', 'action'));

-- --- realtime (0001 pattern): the inbox shows run cards live -----------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.action_runs;
  end if;
end;
$$;
