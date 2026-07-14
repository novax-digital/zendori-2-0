-- ============================================================================
-- AI agents as first-class entities (owner decision 2026-07-14)
--
-- Replaces the org-wide AI knobs (org_settings.autopilot_enabled /
-- confidence_threshold / tone_instructions) and the voice channel's embedded
-- behavioral config (config.agentMode / config.instructions) with named agents:
--   · each agent has an identity (system prompt), a mode and a threshold
--   · channels reference exactly one agent (channels.agent_id); one agent can
--     serve many channels
--   · a channel without an agent gets NO drafts and NO auto-sends (ticketising
--     classification/extraction still runs — inbox hygiene, not bot behavior)
--
-- org_settings keeps the org-level operational knobs (escalation_keywords,
-- business_hours, auto_ack_texts). Its autopilot_enabled / confidence_threshold
-- / tone_instructions columns become UNUSED after this migration (kept for a
-- later cleanup migration; no code reads them anymore).
-- ============================================================================

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  -- Persona / system prompt ("Identitaet"): merged into the AI prompts.
  identity text,
  -- draft_only = suggestions only | autopilot = auto-send above threshold |
  -- intake_only = no RAG answer, just ticketise + hand off ("reine Annahme")
  mode text not null default 'draft_only'
    check (mode in ('draft_only', 'autopilot', 'intake_only')),
  confidence_threshold numeric not null default 0.7
    check (confidence_threshold >= 0 and confidence_threshold <= 1),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  -- composite target so channels can enforce same-org assignment via FK
  unique (id, org_id)
);

create index agents_org_idx on public.agents (org_id);

alter table public.agents enable row level security;

-- select: any org member (the inbox shows agent name/threshold);
-- writes: owners only (identity steers the bot — same sensitivity as
-- org_settings / voice transferNumber). Unlike org_settings this table is
-- user-created 1:N, so it needs explicit insert/delete policies.
create policy agents_select on public.agents
  for select to authenticated using (private.is_org_member(org_id));
create policy agents_insert on public.agents
  for insert to authenticated with check (private.is_org_owner(org_id));
create policy agents_update on public.agents
  for update to authenticated using (private.is_org_owner(org_id));
create policy agents_delete on public.agents
  for delete to authenticated using (private.is_org_owner(org_id));

-- --- channel assignment ------------------------------------------------------

alter table public.channels add column agent_id uuid;

-- Same-org enforced by the composite FK; deleting an agent detaches its
-- channels (column list keeps org_id untouched — PG15+ syntax).
alter table public.channels
  add constraint channels_agent_same_org
  foreign key (agent_id, org_id) references public.agents (id, org_id)
  on delete set null (agent_id);

create index channels_agent_idx on public.channels (agent_id)
  where agent_id is not null;

-- The channels RLS policy (0001 channels_all) is member-level, but assigning an
-- agent changes live bot behavior — owner-only in the app. Enforce that at the
-- DB too, or any member could flip a channel onto an autopilot agent via direct
-- PostgREST. auth.uid() IS NULL = service role / FK referential action (the
-- ON DELETE SET NULL fires this trigger) — those stay allowed.
create or replace function private.guard_channel_agent_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    if tg_op = 'UPDATE'
       and new.agent_id is distinct from old.agent_id
       and not private.is_org_owner(new.org_id) then
      raise exception 'only org owners may change a channel''s agent';
    end if;
    if tg_op = 'INSERT'
       and new.agent_id is not null
       and not private.is_org_owner(new.org_id) then
      raise exception 'only org owners may assign a channel agent';
    end if;
  end if;
  return new;
end;
$$;

create trigger channels_guard_agent_assignment
  before insert or update on public.channels
  for each row execute function private.guard_channel_agent_assignment();

-- --- handoff reason for intake-only agents ------------------------------------

alter table public.handoff_events drop constraint handoff_events_reason_check;
alter table public.handoff_events add constraint handoff_events_reason_check
  check (reason in ('low_confidence', 'user_request', 'keyword', 'manual', 'intake'));

-- --- backfill: behavior-preserving seed ----------------------------------------

-- One Standard-Agent per org from today's org_settings. Mode 'autopilot' when
-- ANY channel type had autopilot on (pragmatic: pre-prod data only), else
-- draft_only (today's default behavior: drafts for everything).
insert into public.agents (org_id, name, identity, mode, confidence_threshold)
select
  os.org_id,
  'Standard-Agent',
  nullif(trim(coalesce(os.tone_instructions, '')), ''),
  case
    when exists (
      select 1
      from jsonb_each(coalesce(os.autopilot_enabled, '{}'::jsonb)) kv
      where kv.value = to_jsonb(true)
    ) then 'autopilot'
    else 'draft_only'
  end,
  coalesce(os.confidence_threshold, 0.7)
from public.org_settings os;

-- Assign the Standard-Agent to all existing non-voice channels.
update public.channels c
set agent_id = a.id
from public.agents a
where a.org_id = c.org_id
  and a.name = 'Standard-Agent'
  and c.type <> 'voice'
  and c.agent_id is null;

-- Voice channels carried their own behavior (config.agentMode/instructions):
-- one dedicated agent per voice channel, then assign it. Voice 'answer' maps to
-- 'autopilot' (it acts autonomously on a live call). Copying config.instructions
-- into agents.identity is a reviewed, accepted decision: pre-prod the only
-- writers were owner-gated actions (a member COULD have written the jsonb via
-- PostgREST, but no such members/data exist; the guard trigger above closes the
-- assignment path going forward).
insert into public.agents (org_id, name, identity, mode, confidence_threshold)
select
  c.org_id,
  'Telefon-Agent ' || left(c.id::text, 8),
  nullif(trim(coalesce(c.config->>'instructions', '')), ''),
  case
    when c.config->>'agentMode' = 'intake_only' then 'intake_only'
    else 'autopilot'
  end,
  0.7
from public.channels c
where c.type = 'voice';

update public.channels c
set agent_id = a.id
from public.agents a
where c.type = 'voice'
  and a.org_id = c.org_id
  and a.name = 'Telefon-Agent ' || left(c.id::text, 8)
  and c.agent_id is null;
