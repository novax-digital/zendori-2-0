-- Zendori v2 — 0037: API-Integration, part 3 (Phase 13d) — the Zendori API for
-- an org's own end system (the way back: end system → Zendori)
--
--   · api_keys              credentials of ONE API connection. Only the SHA-256
--                           of a key is stored; the key itself is shown once.
--   · external_links        the end system's own id for a Zendori ticket /
--                           conversation / contact, per connection — lets it
--                           address records by ITS id ("ext:<id>") and comes
--                           back in every event payload (external_id)
--   · api_idempotency_keys  replay store for non-idempotent requests (notes)
--
-- The public routes (/api/v1/*) run with the service role after checking the
-- key and tag their requests with x-zendori-origin-connection, so the 0036
-- triggers do not report a change back to the system that made it.
--
-- Scope (CLAUDE.md §2): the API changes existing records and adds internal
-- notes. It does NOT create conversations or messages — that would be a third
-- intake path next to inbound e-mail and the form builder.
--
-- Rollout order: app deploy first, then this migration (requires 0035, 0036).

-- --- api keys ---------------------------------------------------------------------
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  connection_id uuid not null,
  name text not null check (char_length(name) between 2 and 80),
  -- first characters of the key ("zk_live_Ab12…"), to recognise it in the list
  key_prefix text not null check (char_length(key_prefix) between 8 and 20),
  -- hex SHA-256 of the full key (256 bits of entropy — no salt needed)
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (connection_id, org_id)
    references public.api_connections (id, org_id) on delete cascade
);

create index api_keys_connection_idx on public.api_keys (connection_id);

alter table public.api_keys enable row level security;

-- A key grants write access to tickets and contacts → owner/admin only.
create policy api_keys_select on public.api_keys
  for select to authenticated using (private.is_org_owner(org_id));
create policy api_keys_insert on public.api_keys
  for insert to authenticated with check (private.is_org_owner(org_id));
create policy api_keys_update on public.api_keys
  for update to authenticated
  using (private.is_org_owner(org_id))
  with check (private.is_org_owner(org_id));
create policy api_keys_delete on public.api_keys
  for delete to authenticated using (private.is_org_owner(org_id));

-- A key is created once and can only be revoked afterwards: neither the hash
-- nor the connection may be swapped under an existing key (that would turn a
-- revoked or foreign key back into a valid one). Service role is exempt.
create or replace function private.guard_api_key_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    if new.key_hash is distinct from old.key_hash
       or new.key_prefix is distinct from old.key_prefix
       or new.connection_id is distinct from old.connection_id
       or new.org_id is distinct from old.org_id then
      raise exception 'api keys are immutable — revoke and create a new one';
    end if;
    if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
      raise exception 'a revoked api key stays revoked';
    end if;
  end if;
  return new;
end;
$$;

create trigger api_keys_guard_update
  before update on public.api_keys
  for each row execute function private.guard_api_key_update();

-- --- external links ---------------------------------------------------------------
create table public.external_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  connection_id uuid not null,
  entity_type text not null check (entity_type in ('ticket', 'conversation', 'contact')),
  entity_id uuid not null,
  external_id text not null check (char_length(external_id) between 1 and 200),
  created_at timestamptz not null default now(),
  -- one external id per record and connection, and vice versa
  unique (connection_id, entity_type, entity_id),
  unique (connection_id, entity_type, external_id),
  foreign key (connection_id, org_id)
    references public.api_connections (id, org_id) on delete cascade
);

create index external_links_entity_idx on public.external_links (entity_type, entity_id);

alter table public.external_links enable row level security;

create policy external_links_select on public.external_links
  for select to authenticated using (private.is_org_member(org_id));
-- No client write policies: only the public API (service role) links records.

-- entity_id is polymorphic (no FK) → remove links when the record goes away.
create or replace function private.drop_external_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.external_links l
  where l.entity_type = tg_argv[0] and l.entity_id = old.id;
  return old;
end;
$$;

create trigger tickets_drop_external_links
  after delete on public.tickets
  for each row execute function private.drop_external_links('ticket');
create trigger conversations_drop_external_links
  after delete on public.conversations
  for each row execute function private.drop_external_links('conversation');
create trigger contacts_drop_external_links
  after delete on public.contacts
  for each row execute function private.drop_external_links('contact');

-- --- idempotency store --------------------------------------------------------------
-- A repeated POST with the same Idempotency-Key (per api key) gets the first
-- response replayed instead of creating a second note. Pruned by the worker.
create table public.api_idempotency_keys (
  api_key_id uuid not null references public.api_keys (id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  org_id uuid not null references public.organizations (id) on delete cascade,
  response_status integer not null,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (api_key_id, idempotency_key)
);

create index api_idempotency_keys_created_idx on public.api_idempotency_keys (created_at);

alter table public.api_idempotency_keys enable row level security;
-- RLS without policies: service role only.
