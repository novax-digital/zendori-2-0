-- 0019: Form builder (Phase 10) — forms + form_notifications.
--
-- A builder form is a normal email/inbound channel (purpose='form',
-- config.builderForm=true) plus exactly one `forms` row carrying the visual
-- definition, the public embed token and the notification recipients. Each
-- submission becomes a normal conversation + message (processing_state
-- 'pending'); `form_notifications` queues the styled forwarding e-mail for the
-- worker (state pending → sent|failed).
--
-- Rollout order: app deploy first (routes 404-tolerate the missing tables),
-- then db push, then the builder UI is usable.

-- Composite-FK target so forms can prove same-org channel linkage
-- (pattern of 0011 agents / 0012 knowledge_bases; channels had no such key).
alter table public.channels
  add constraint channels_id_org_unique unique (id, org_id);

create table public.forms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  channel_id uuid not null unique,
  name text not null,
  -- 32-hex public embed token (identifies the form, not a credential)
  public_token text not null unique,
  -- zod-validated at the app boundary (formDefinitionSchema)
  definition jsonb not null,
  version integer not null default 1,
  -- string[] of recipient addresses (max 10, z.email()-validated in the app)
  notification_emails jsonb not null default '[]'::jsonb,
  -- hard per-day submission cap (cost brake for the public endpoint)
  daily_submission_limit integer not null default 200
    check (daily_submission_limit between 1 and 10000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (channel_id, org_id)
    references public.channels (id, org_id) on delete cascade
);

create index forms_org_idx on public.forms (org_id);

alter table public.forms enable row level security;

-- Content is member-managed (knowledge_bases pattern); deleting is owner-only.
-- Sensitive columns are additionally guarded by trigger below.
create policy forms_select on public.forms
  for select to authenticated using (private.is_org_member(org_id));
create policy forms_insert on public.forms
  for insert to authenticated with check (private.is_org_member(org_id));
create policy forms_update on public.forms
  for update to authenticated
  using (private.is_org_member(org_id))
  with check (private.is_org_member(org_id));
create policy forms_delete on public.forms
  for delete to authenticated using (private.is_org_owner(org_id));
-- Public lookups (bootstrap/submit) run through the service role — no anon policies.

-- Integrity + privilege guard:
--  * a forms row may only ever point at a builder-form channel of the same org
--    (email channel flagged config.builderForm=true) and the link is immutable;
--  * public_token is immutable for clients;
--  * notification_emails / daily_submission_limit are owner-only (a member
--    rewriting recipients could exfiltrate every future PII submission).
-- Service role (auth.uid() is null) bypasses the role checks, never the
-- channel-shape check.
create or replace function private.guard_forms_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel record;
begin
  if tg_op = 'INSERT' or new.channel_id is distinct from old.channel_id then
    if tg_op = 'UPDATE' then
      raise exception 'forms.channel_id is immutable';
    end if;
    select c.type, c.config into v_channel
      from public.channels c
      where c.id = new.channel_id and c.org_id = new.org_id;
    if v_channel is null
       or v_channel.type <> 'email'
       or coalesce(v_channel.config->>'builderForm', '') <> 'true' then
      raise exception 'forms must reference a builder-form email channel of the same org';
    end if;
  end if;

  if tg_op = 'UPDATE' and auth.uid() is not null then
    if new.public_token is distinct from old.public_token then
      raise exception 'forms.public_token is immutable';
    end if;
    if (new.notification_emails is distinct from old.notification_emails
        or new.daily_submission_limit is distinct from old.daily_submission_limit)
       and not private.is_org_owner(new.org_id) then
      raise exception 'only owners may change notification recipients or limits';
    end if;
  end if;

  -- The owner-only columns must not be settable on the INSERT path either —
  -- otherwise a member simply creates a form WITH recipients instead of
  -- editing one.
  if tg_op = 'INSERT' and auth.uid() is not null
     and not private.is_org_owner(new.org_id) then
    if new.notification_emails <> '[]'::jsonb then
      raise exception 'only owners may set notification recipients';
    end if;
    if new.daily_submission_limit <> 200 then
      raise exception 'only owners may set submission limits';
    end if;
  end if;

  return new;
end;
$$;

create trigger forms_guard
  before insert or update on public.forms
  for each row execute function private.guard_forms_row();

-- The owner-only forms_delete policy would be bypassable via the channel:
-- channels are member-writable (0001), and deleting the channel cascades the
-- forms row (FK actions bypass RLS). Builder-form channels are therefore
-- owner-only to delete. Service role (auth.uid() null) stays unrestricted.
create or replace function private.guard_channel_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null
     and coalesce(old.config->>'builderForm', '') = 'true'
     and not private.is_org_owner(old.org_id) then
    raise exception 'only owners may delete form-builder channels';
  end if;
  return old;
end;
$$;

create trigger channels_guard_delete
  before delete on public.channels
  for each row execute function private.guard_channel_delete();

-- Forwarding queue: one row per submission that has recipients configured.
-- Written by the submit route (service role), processed by the worker.
create table public.form_notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  form_id uuid not null references public.forms (id) on delete cascade,
  message_id uuid not null unique references public.messages (id) on delete cascade,
  -- recipient snapshot at submit time (string[])
  recipients jsonb not null,
  state text not null default 'pending' check (state in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index form_notifications_pending_idx
  on public.form_notifications (created_at)
  where state = 'pending';

alter table public.form_notifications enable row level security;

create policy form_notifications_select on public.form_notifications
  for select to authenticated using (private.is_org_member(org_id));
-- No insert/update/delete policies: writes are service-role only
-- (submit route creates, worker updates).
