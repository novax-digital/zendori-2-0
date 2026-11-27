-- Zendori v2 — 0050: test conversations (tab "Test" of a chat channel)
--
-- Owner request 2026-11-27: the chat widget can be tried out inside Zendori —
-- on the channel's own tab "Test", also while the channel is still a draft
-- (inactive) and whatever mode the agent is in. A conversation started there is
-- a TEST conversation:
--
--   conversations.is_test = true
--
-- It shows up in the inbox like any other (with a "Test" mark) and the bot
-- answers it, but nothing leaves Zendori because of it:
--
--   · no e-mail to team members       (0038 triggers)
--   · no event to the customer's own  (0036 triggers; a contact that only
--     end system                       belongs to test conversations stays
--                                      silent as well)
--   · no ticket                       (guard below; ensureTicket() in
--                                      packages/core checks first and never
--                                      gets this far)
--   · no HubSpot sync                 (worker, see docs/webchat-test.md)
--
-- The widget API sets the flag when it starts the session, after it has
-- verified the signed-in member. Usage is counted like any other conversation.
--
-- Rollout order: this migration FIRST, then the app. The running code does not
-- know the column and behaves as before (default false).

alter table public.conversations
  add column is_test boolean not null default false;

comment on column public.conversations.is_test is
  'Started from the tab "Test" of a chat channel: no tickets, no member mails, no integration events, no HubSpot.';

-- --- member notifications (0038) --------------------------------------------------
-- New conversation / assignment: the WHEN clause keeps test conversations away
-- from the trigger function entirely.
drop trigger conversations_notify_members_insert on public.conversations;
create trigger conversations_notify_members_insert
  after insert on public.conversations
  for each row
  when (not new.is_test)
  execute function private.notify_conversation_members();

drop trigger conversations_notify_members_update on public.conversations;
create trigger conversations_notify_members_update
  after update on public.conversations
  for each row
  when (old.assignee_id is distinct from new.assignee_id and not new.is_test)
  execute function private.notify_conversation_members();

-- A handoff that leaves a conversation waiting for a human — not when it was
-- only tried out.
create or replace function private.notify_handoff_members()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.conversations c
    where c.id = new.conversation_id and c.is_test
  ) then
    return new;
  end if;
  perform private.enqueue_member_notification(
    new.org_id, 'handoff.pending', 'conversation', new.conversation_id, null,
    jsonb_build_object('reason', new.reason), null);
  return new;
end;
$$;

-- --- integration events (0036) ----------------------------------------------------
drop trigger conversations_emit_integration_event_insert on public.conversations;
create trigger conversations_emit_integration_event_insert
  after insert on public.conversations
  for each row
  when (not new.is_test)
  execute function private.emit_conversation_event();

drop trigger conversations_emit_integration_event_update on public.conversations;
create trigger conversations_emit_integration_event_update
  after update on public.conversations
  for each row
  when (not new.is_test
    and (old.status is distinct from new.status
      or old.mode is distinct from new.mode
      or old.assignee_id is distinct from new.assignee_id
      or old.contact_id is distinct from new.contact_id))
  execute function private.emit_conversation_event();

-- A contact that belongs to test conversations ONLY is the tester's own entry
-- (name / e-mail typed into the widget's contact prompt): no event. As soon as
-- a real conversation points at the contact, it is reported as before.
create or replace function private.emit_contact_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}'::text[];
begin
  if exists (
       select 1 from public.conversations c
       where c.contact_id = new.id and c.is_test)
     and not exists (
       select 1 from public.conversations c
       where c.contact_id = new.id and not c.is_test) then
    return new;
  end if;
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

-- --- tickets ----------------------------------------------------------------------
-- A ticket is the work object of a real request and takes a number from the
-- org's own number range — a test conversation never gets one. The name sorts
-- before tickets_prepare_row, so no number is allocated first.
create or replace function private.refuse_test_ticket()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.conversations c
    where c.id = new.conversation_id and c.is_test
  ) then
    raise exception 'test conversations have no tickets' using errcode = 'ZT001';
  end if;
  return new;
end;
$$;

create trigger tickets_guard_test
  before insert on public.tickets
  for each row execute function private.refuse_test_ticket();
