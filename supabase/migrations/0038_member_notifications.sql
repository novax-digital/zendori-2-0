-- Zendori v2 — 0038: e-mail notifications for team members
--
-- Every member decides per organization which events they want an e-mail for
-- (Einstellungen → Benachrichtigungen):
--   · notification_preferences   one row per (org, member): the chosen events
--   · member_notifications       the queue: one row per (event, subscribed member)
--   · triggers on conversations / tickets / handoff_events fill the queue, so
--     every writer is covered (web app, worker, public API) without app code
--
-- Events (NOTIFICATION_EVENTS in packages/core/src/notifications.ts):
--   conversation.new   a conversation was created
--   ticket.new         a ticket was created
--   handoff.pending    the AI agent handed a conversation to the team
--   assigned           a conversation / ticket was assigned to the member
--
-- Delivery is the worker's job: it checks that the member may see the record
-- (area + channel scope), skips spam, renders the template and sends through
-- Resend. Rows are content-free (ids only). Nobody is notified about their own
-- action, and nothing is sent without an explicit opt-in (no row = no mails).
--
-- Safety: a queue problem must never break a core write — the enqueue function
-- swallows its own errors (0036 pattern).
--
-- Rollout order: app deploy first (web and worker tolerate the missing tables),
-- then this migration.

-- --- preferences ------------------------------------------------------------------
create table public.notification_preferences (
  org_id uuid not null,
  user_id uuid not null,
  -- known keys only matter; unknown values are ignored by the app
  events text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id),
  -- leaving the org (or deleting it) removes the preferences
  foreign key (org_id, user_id)
    references public.org_members (org_id, user_id) on delete cascade
);

alter table public.notification_preferences enable row level security;

-- Personal settings: a member reads and writes ONLY their own row, and only
-- while they belong to the org.
create policy notification_preferences_select on public.notification_preferences
  for select to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(org_id));
create policy notification_preferences_insert on public.notification_preferences
  for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_org_member(org_id));
create policy notification_preferences_update on public.notification_preferences
  for update to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(org_id))
  with check (user_id = (select auth.uid()) and private.is_org_member(org_id));
create policy notification_preferences_delete on public.notification_preferences
  for delete to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(org_id));

-- --- queue ------------------------------------------------------------------------
create table public.member_notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  event_type text not null,
  entity_type text not null check (entity_type in ('conversation', 'ticket')),
  entity_id uuid not null,
  -- who caused the event (a signed-in member); null = customer, AI agent, worker
  actor_id uuid,
  -- content-free facts, e.g. the handoff reason
  details jsonb not null default '{}'::jsonb,
  state text not null default 'pending'
    check (state in ('pending', 'sent', 'skipped', 'failed')),
  attempts integer not null default 0,
  -- when the worker may try (again); also the claim lease while a try runs
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index member_notifications_due_idx
  on public.member_notifications (next_attempt_at)
  where state = 'pending';
create index member_notifications_entity_idx
  on public.member_notifications (user_id, entity_id);
create index member_notifications_created_idx on public.member_notifications (created_at);

alter table public.member_notifications enable row level security;
-- RLS without policies: triggers and the worker (service role) only.

-- --- queue writer -----------------------------------------------------------------
-- One row per member who subscribed to the event. p_only_user narrows it to one
-- member (assignment). The acting member never gets a mail about their own action.
create or replace function private.enqueue_member_notification(
  p_org_id uuid,
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_only_user uuid,
  p_details jsonb,
  p_delay interval
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  v_actor := (select auth.uid());
  insert into public.member_notifications
    (org_id, user_id, event_type, entity_type, entity_id, actor_id, details, next_attempt_at)
  select p.org_id, p.user_id, p_event_type, p_entity_type, p_entity_id, v_actor,
         coalesce(p_details, '{}'::jsonb), now() + coalesce(p_delay, interval '0')
  from public.notification_preferences p
  where p.org_id = p_org_id
    and p_event_type = any (p.events)
    and (p_only_user is null or p.user_id = p_only_user)
    and (v_actor is null or p.user_id <> v_actor);
exception when others then
  -- never fail the conversation / ticket / handoff write because of a notification
  null;
end;
$$;

-- --- triggers ---------------------------------------------------------------------
create or replace function private.notify_conversation_members()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- delayed: the worker waits for the first message's spam check anyway
    perform private.enqueue_member_notification(
      new.org_id, 'conversation.new', 'conversation', new.id, null, '{}'::jsonb,
      interval '20 seconds');
  end if;
  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    perform private.enqueue_member_notification(
      new.org_id, 'assigned', 'conversation', new.id, new.assignee_id, '{}'::jsonb, null);
  end if;
  return new;
end;
$$;

create trigger conversations_notify_members_insert
  after insert on public.conversations
  for each row execute function private.notify_conversation_members();

-- conversations are updated on EVERY message (last_message_at): the WHEN clause
-- keeps the trigger function off that hot path entirely.
create trigger conversations_notify_members_update
  after update on public.conversations
  for each row
  when (old.assignee_id is distinct from new.assignee_id)
  execute function private.notify_conversation_members();

create or replace function private.notify_ticket_members()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.enqueue_member_notification(
      new.org_id, 'ticket.new', 'ticket', new.id, null, '{}'::jsonb, null);
  end if;
  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    perform private.enqueue_member_notification(
      new.org_id, 'assigned', 'ticket', new.id, new.assignee_id, '{}'::jsonb, null);
  end if;
  return new;
end;
$$;

create trigger tickets_notify_members_insert
  after insert on public.tickets
  for each row execute function private.notify_ticket_members();

create trigger tickets_notify_members_update
  after update on public.tickets
  for each row
  when (old.assignee_id is distinct from new.assignee_id)
  execute function private.notify_ticket_members();

-- A handoff that leaves a conversation waiting for a human. Not for a manual
-- takeover (the member is already there), not for transferred calls, not for
-- callback tickets (those raise ticket.new) and not for suppressed handoffs.
create or replace function private.notify_handoff_members()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enqueue_member_notification(
    new.org_id, 'handoff.pending', 'conversation', new.conversation_id, null,
    jsonb_build_object('reason', new.reason), null);
  return new;
end;
$$;

create trigger handoff_events_notify_members
  after insert on public.handoff_events
  for each row
  when (new.outcome in ('pending_human', 'transfer_failed') and new.reason <> 'manual')
  execute function private.notify_handoff_members();
