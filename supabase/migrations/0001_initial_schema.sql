-- Zendori v2 — initial schema (CLAUDE.md §5)
-- Multi-tenant: every table carries org_id, RLS on every table,
-- access only via org_members. Worker uses the service role (bypasses RLS).

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ============================================================================
-- helper schema (not exposed via PostgREST)
-- ============================================================================

create schema if not exists private;

-- ============================================================================
-- organizations & membership
-- ============================================================================

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'agent')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null,
  role text not null default 'agent' check (role in ('owner', 'agent')),
  token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

-- membership helpers (security definer: bypasses RLS, prevents policy recursion)
create or replace function private.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = (select auth.uid())
  );
$$;

create or replace function private.is_org_owner(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = (select auth.uid()) and m.role = 'owner'
  );
$$;

grant usage on schema private to authenticated;
grant execute on function private.is_org_member(uuid) to authenticated;
grant execute on function private.is_org_owner(uuid) to authenticated;

-- creator becomes owner automatically (skipped for service-role inserts)
create or replace function private.handle_new_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    insert into public.org_members (org_id, user_id, role)
    values (new.id, (select auth.uid()), 'owner');
  end if;
  insert into public.org_settings (org_id) values (new.id);
  return new;
end;
$$;

-- ============================================================================
-- channels & integrations
-- ============================================================================

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  type text not null check (type in ('chat', 'email', 'whatsapp', 'voice')),
  name text not null,
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- inbound email routing: one intake address maps to exactly one channel
create unique index channels_email_inbound_address_idx
  on public.channels ((config ->> 'address'))
  where type = 'email' and config ->> 'mode' = 'inbound';

create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  type text not null check (type in ('hubspot')),
  config jsonb not null default '{}'::jsonb,
  rules jsonb not null default '{"mode": "manual"}'::jsonb,
  is_active boolean not null default false,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, type)
);

-- ============================================================================
-- contacts, conversations, messages
-- ============================================================================

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text,
  email text,
  phone text,
  wa_id text,
  external_ids jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index contacts_org_email_idx on public.contacts (org_id, email);
create index contacts_org_phone_idx on public.contacts (org_id, phone);
create index contacts_org_wa_id_idx on public.contacts (org_id, wa_id);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  subject text,
  status text not null default 'open' check (status in ('open', 'pending', 'resolved')),
  mode text not null default 'bot' check (mode in ('bot', 'human')),
  assignee_id uuid references auth.users (id) on delete set null,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  last_message_at timestamptz,
  external_refs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index conversations_inbox_idx
  on public.conversations (org_id, status, last_message_at desc nulls last);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  sender_type text not null check (sender_type in ('contact', 'agent', 'bot', 'system')),
  content text not null,
  content_type text not null default 'text'
    check (content_type in ('text', 'html', 'audio', 'image', 'file')),
  external_id text,
  metadata jsonb not null default '{}'::jsonb,
  -- only relevant for direction = 'in'; drives the worker poll
  processing_state text check (processing_state in ('pending', 'done', 'skipped')),
  created_at timestamptz not null default now(),
  constraint messages_processing_state_only_inbound
    check (direction = 'in' or processing_state is null)
);

-- idempotency: external_id unique per channel
create unique index messages_channel_external_id_idx
  on public.messages (channel_id, external_id)
  where external_id is not null;

create index messages_conversation_idx on public.messages (conversation_id, created_at);

-- worker poll: pending inbound messages
create index messages_pending_idx
  on public.messages (created_at)
  where direction = 'in' and processing_state = 'pending';

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  storage_path text not null,
  mime text not null,
  size bigint not null,
  created_at timestamptz not null default now()
);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  author_id uuid references auth.users (id) on delete set null,
  content text not null,
  created_at timestamptz not null default now()
);

create table public.canned_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  shortcut text not null,
  content text not null,
  created_at timestamptz not null default now(),
  unique (org_id, shortcut)
);

-- ============================================================================
-- knowledge base
-- ============================================================================

create table public.kb_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  type text not null check (type in ('url', 'file', 'text')),
  uri text,
  status text not null default 'pending' check (status in ('pending', 'indexed', 'error')),
  last_indexed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  source_id uuid not null references public.kb_sources (id) on delete cascade,
  content text not null,
  embedding extensions.vector(1536),
  token_count integer,
  created_at timestamptz not null default now()
);

create index kb_chunks_embedding_idx
  on public.kb_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index kb_chunks_org_idx on public.kb_chunks (org_id);

-- ============================================================================
-- AI observability & handoff
-- ============================================================================

create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  step text not null check (step in ('classify', 'extract', 'retrieve', 'draft')),
  model text not null,
  input_summary text,
  output_summary text,
  confidence numeric,
  latency_ms integer,
  cost_usd numeric,
  created_at timestamptz not null default now()
);

create table public.handoff_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  reason text not null check (reason in ('low_confidence', 'user_request', 'keyword', 'manual')),
  triggered_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- org settings
-- ============================================================================

create table public.org_settings (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  -- per channel type: {"chat": true, "email": false, ...}
  autopilot_enabled jsonb not null default '{}'::jsonb,
  confidence_threshold numeric not null default 0.7
    check (confidence_threshold >= 0 and confidence_threshold <= 1),
  tone_instructions text,
  business_hours jsonb,
  auto_ack_texts jsonb not null default '{}'::jsonb,
  escalation_keywords text[] not null
    default array['kündigung', 'beschwerde', 'anwalt', 'datenschutz'],
  created_at timestamptz not null default now()
);

-- trigger AFTER org_settings exists (handle_new_organization inserts into it)
create trigger on_organization_created
  after insert on public.organizations
  for each row execute function private.handle_new_organization();

-- ============================================================================
-- invite flow (security definer keeps invites/org_members closed by default)
-- ============================================================================

create or replace function public.invite_details(p_token text)
returns table (org_name text, email text, role text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name, i.email, i.role, i.expires_at
  from public.invites i
  join public.organizations o on o.id = i.org_id
  where i.token = p_token and i.accepted_at is null and i.expires_at > now();
$$;

create or replace function public.accept_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.invites%rowtype;
  v_user_email text;
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated';
  end if;

  select * into v_invite
  from public.invites
  where token = p_token and accepted_at is null and expires_at > now()
  for update;

  if not found then
    raise exception 'invite not found or expired';
  end if;

  select lower(u.email) into v_user_email from auth.users u where u.id = (select auth.uid());
  if v_user_email is distinct from lower(v_invite.email) then
    raise exception 'invite was issued for a different email address';
  end if;

  insert into public.org_members (org_id, user_id, role)
  values (v_invite.org_id, (select auth.uid()), v_invite.role)
  on conflict (org_id, user_id) do nothing;

  update public.invites set accepted_at = now() where id = v_invite.id;

  return v_invite.org_id;
end;
$$;

grant execute on function public.invite_details(text) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.invites enable row level security;
alter table public.channels enable row level security;
alter table public.integrations enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.attachments enable row level security;
alter table public.notes enable row level security;
alter table public.canned_responses enable row level security;
alter table public.kb_sources enable row level security;
alter table public.kb_chunks enable row level security;
alter table public.ai_runs enable row level security;
alter table public.handoff_events enable row level security;
alter table public.org_settings enable row level security;

-- organizations: any authenticated user may create one (becomes owner via trigger)
create policy organizations_select on public.organizations
  for select to authenticated using (private.is_org_member(id));
create policy organizations_insert on public.organizations
  for insert to authenticated with check (true);
create policy organizations_update on public.organizations
  for update to authenticated using (private.is_org_owner(id));
create policy organizations_delete on public.organizations
  for delete to authenticated using (private.is_org_owner(id));

-- org_members: visible to fellow members; managed by owners; self-leave allowed
create policy org_members_select on public.org_members
  for select to authenticated using (private.is_org_member(org_id));
create policy org_members_insert on public.org_members
  for insert to authenticated with check (private.is_org_owner(org_id));
create policy org_members_update on public.org_members
  for update to authenticated using (private.is_org_owner(org_id));
create policy org_members_delete on public.org_members
  for delete to authenticated
  using (private.is_org_owner(org_id) or user_id = (select auth.uid()));

-- invites: owners only (redeem runs through accept_invite / invite_details)
create policy invites_select on public.invites
  for select to authenticated using (private.is_org_owner(org_id));
create policy invites_insert on public.invites
  for insert to authenticated with check (private.is_org_owner(org_id));
create policy invites_delete on public.invites
  for delete to authenticated using (private.is_org_owner(org_id));

-- all other org-scoped tables: full access for org members
create policy channels_all on public.channels
  for all to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));

create policy integrations_all on public.integrations
  for all to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));

create policy contacts_all on public.contacts
  for all to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));

create policy conversations_all on public.conversations
  for all to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));

create policy messages_all on public.messages
  for all to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));

create policy attachments_all on public.attachments
  for all to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));

create policy notes_all on public.notes
  for all to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));

create policy canned_responses_all on public.canned_responses
  for all to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));

create policy kb_sources_all on public.kb_sources
  for all to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));

create policy kb_chunks_all on public.kb_chunks
  for all to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));

create policy ai_runs_select on public.ai_runs
  for select to authenticated using (private.is_org_member(org_id));

create policy handoff_events_select on public.handoff_events
  for select to authenticated using (private.is_org_member(org_id));
create policy handoff_events_insert on public.handoff_events
  for insert to authenticated with check (private.is_org_member(org_id));

create policy org_settings_select on public.org_settings
  for select to authenticated using (private.is_org_member(org_id));
create policy org_settings_update on public.org_settings
  for update to authenticated using (private.is_org_owner(org_id));

-- ============================================================================
-- realtime
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.conversations;
    alter publication supabase_realtime add table public.messages;
  end if;
end;
$$;
