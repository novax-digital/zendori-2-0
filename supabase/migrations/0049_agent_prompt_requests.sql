-- Zendori v2 — 0049: KI-Vorschlag für die Identität eines Agenten
--
-- In the agent editor an owner or admin types a few notes ("Kundenservice für
-- Solaranlagen, duzen, keine Preise nennen") and gets a suggested identity
-- (system prompt) to take over or to drop. The web app never talks to an AI
-- provider (CLAUDE.md §4): it asks for the text with request_agent_prompt(),
-- the WORKER writes it, and the editor reads the row until it is finished.
--
--   queued → running → succeeded | failed
--
-- A row holds what the member typed and the suggestion — configuration, no
-- customer messages. The worker deletes rows after a week. Nothing here changes
-- an agent: the suggestion only reaches `agents.identity` when the member takes
-- it over and saves the agent.

create table public.agent_prompt_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  -- a voice agent speaks, a text agent writes — the suggestion differs
  agent_kind text not null check (agent_kind in ('text', 'voice')),
  agent_name text not null default '' check (char_length(agent_name) <= 80),
  -- what the member typed
  notes text not null check (char_length(notes) between 10 and 4000),
  -- the identity as it stands, when the member asked to improve it
  current_identity text
    check (current_identity is null or char_length(current_identity) <= 8000),
  state text not null default 'queued'
    check (state in ('queued', 'running', 'succeeded', 'failed')),
  -- the suggested identity
  result text,
  -- a fixed word (not_configured | ai_failed | empty_result | expired | stale)
  error_code text,
  model text,
  cost_usd numeric,
  latency_ms integer,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- hourly cap per org + cleanup
create index agent_prompt_requests_org_created_idx
  on public.agent_prompt_requests (org_id, created_at desc);
-- worker scan
create index agent_prompt_requests_queued_idx
  on public.agent_prompt_requests (created_at) where state = 'queued';

alter table public.agent_prompt_requests enable row level security;

-- A member reads the requests they made themselves, as long as they may still
-- manage agents (owner/admin). No client write policies: rows are written by
-- the function below and by the worker (service role).
create policy agent_prompt_requests_select on public.agent_prompt_requests
  for select to authenticated
  using (requested_by = (select auth.uid()) and private.is_org_owner(org_id));

-- The only client entry point: an owner or admin of the org asks for a
-- suggestion. At most 20 per org and hour.
create or replace function public.request_agent_prompt(
  p_org_id uuid,
  p_agent_kind text,
  p_agent_name text,
  p_notes text,
  p_current_identity text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_recent integer;
  v_name text := left(btrim(coalesce(p_agent_name, '')), 80);
  v_notes text := btrim(coalesce(p_notes, ''));
  v_current text := nullif(btrim(coalesce(p_current_identity, '')), '');
begin
  if p_org_id is null or not private.is_org_owner(p_org_id) then
    raise exception 'not allowed';
  end if;
  if p_agent_kind is null or p_agent_kind not in ('text', 'voice') then
    raise exception 'invalid agent kind';
  end if;
  if char_length(v_notes) < 10 or char_length(v_notes) > 4000 then
    raise exception 'invalid notes';
  end if;
  if v_current is not null and char_length(v_current) > 8000 then
    raise exception 'invalid identity';
  end if;

  select count(*) into v_recent
    from public.agent_prompt_requests r
   where r.org_id = p_org_id and r.created_at > now() - interval '1 hour';
  if v_recent >= 20 then
    raise exception 'rate_limited';
  end if;

  insert into public.agent_prompt_requests
    (org_id, requested_by, agent_kind, agent_name, notes, current_identity)
  values (p_org_id, (select auth.uid()), p_agent_kind, v_name, v_notes, v_current)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.request_agent_prompt(uuid, text, text, text, text) from public;
revoke all on function public.request_agent_prompt(uuid, text, text, text, text) from anon;
grant execute on function public.request_agent_prompt(uuid, text, text, text, text) to authenticated;
