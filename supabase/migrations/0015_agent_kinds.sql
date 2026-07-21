-- ============================================================================
-- Agent kinds: voice agents vs text agents (owner decision 2026-07-21)
--
-- A voice agent serves ONLY voice channels; a text agent serves everything
-- else (chat, email, whatsapp). Voice agents know only two behaviors:
-- intake_only ("Reine Annahme") and autopilot — draft_only is meaningless on a
-- live call (there is no human review step mid-conversation).
-- ============================================================================

alter table public.agents add column kind text not null default 'text'
  check (kind in ('text', 'voice'));

-- --- backfill ----------------------------------------------------------------

-- Agents that serve ONLY voice channels become voice agents.
update public.agents a
set kind = 'voice'
where exists (
    select 1 from public.channels c where c.agent_id = a.id and c.type = 'voice'
  )
  and not exists (
    select 1 from public.channels c where c.agent_id = a.id and c.type <> 'voice'
  );

-- Mixed-assignment agents (voice AND non-voice channels) stay 'text'; their
-- voice channels are detached. A voice channel without an agent answers in the
-- safe intake fallback (dispatch.ts), so this is non-destructive and visible
-- in the UI. Pre-prod data volumes only.
update public.channels c
set agent_id = null
where c.type = 'voice'
  and c.agent_id is not null
  and exists (select 1 from public.agents a where a.id = c.agent_id and a.kind = 'text');

-- Voice agents can only be intake_only or autopilot.
update public.agents set mode = 'intake_only' where kind = 'voice' and mode = 'draft_only';

alter table public.agents add constraint agents_voice_mode_check
  check (kind <> 'voice' or mode in ('intake_only', 'autopilot'));

-- --- enforcement: assignment must match kind -----------------------------------

-- Extend the 0011 guard: besides the owner-only rule, the assigned agent's kind
-- must match the channel type (voice channel ⇔ voice agent). The kind check is
-- data integrity, not authorization — it applies to the service role too.
create or replace function private.guard_channel_agent_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
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

  if new.agent_id is not null then
    select kind into v_kind from public.agents where id = new.agent_id;
    if v_kind = 'voice' and new.type <> 'voice' then
      raise exception 'a voice agent can only serve voice channels';
    end if;
    if v_kind = 'text' and new.type = 'voice' then
      raise exception 'a text agent cannot serve voice channels';
    end if;
  end if;
  return new;
end;
$$;

-- An agent's kind is immutable while channels reference it — otherwise a kind
-- flip would silently invalidate existing assignments.
create or replace function private.guard_agent_kind_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind
     and exists (select 1 from public.channels c where c.agent_id = new.id) then
    raise exception 'cannot change agent kind while channels are assigned';
  end if;
  return new;
end;
$$;

create trigger agents_guard_kind_change
  before update on public.agents
  for each row execute function private.guard_agent_kind_change();
