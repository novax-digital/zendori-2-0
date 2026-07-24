-- Zendori v2 — 0024: team roles (admin) + granular member permissions
--
-- Customers manage their own team (modeled after App-Control): owners/admins
-- invite members by e-mail (no password typed — the invitee sets it via a
-- mailed recovery link), and "Mitarbeiter" (role agent) get granular
-- permissions: per-area view/edit plus an inbox channel scope. Shapes are
-- validated in app code (packages/core/src/permissions.ts).
--
-- Role model:
--   owner — the account owner. Only owners may delete the org, manage other
--           owners, or promote someone to owner.
--   admin — full rights everywhere else. Implemented by extending
--           private.is_org_owner() so every existing owner-gated policy and
--           trigger guard (agents, forms, channels, org_settings, members,
--           invites, phone_numbers, agent_knowledge_bases) applies unchanged.
--   agent — "Mitarbeiter": app-level gating via org_members.permissions.

-- 1. Roles: allow 'admin' on memberships and invites; add permissions jsonb.
alter table public.org_members drop constraint org_members_role_check;
alter table public.org_members
  add constraint org_members_role_check check (role in ('owner', 'admin', 'agent'));
alter table public.org_members
  add column permissions jsonb not null default '{}'::jsonb;

alter table public.invites drop constraint invites_role_check;
alter table public.invites
  add constraint invites_role_check check (role in ('owner', 'admin', 'agent'));
alter table public.invites
  add column permissions jsonb not null default '{}'::jsonb;

-- Backfill: pre-0024 agents had full member access (settings read-only, no
-- billing). Without this, '{}' would mean "no areas" and every existing
-- Mitarbeiter would be locked out of the app the moment the gating ships.
-- Mirrors LEGACY_AGENT_PERMISSIONS in packages/core/src/permissions.ts.
update public.org_members
set permissions = '{
  "areas": {
    "inbox": "edit", "knowledge": "edit", "canned": "edit",
    "agents": "view", "channels": "view", "handoff": "view"
  },
  "channelIds": null
}'::jsonb
where role = 'agent';

-- 2. Admins become owner-equivalent in the DB: ONE lever for all policies.
create or replace function private.is_org_owner(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;

-- 3. True-owner helper for the few owner-ONLY spots (org deletion, owner rows).
create or replace function private.is_org_true_owner(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = (select auth.uid())
      and m.role = 'owner'
  );
$$;
grant execute on function private.is_org_true_owner(uuid) to authenticated;

-- Deleting the whole org stays a TRUE-owner right (admins must not).
drop policy organizations_delete on public.organizations;
create policy organizations_delete on public.organizations
  for delete to authenticated using (private.is_org_true_owner(id));

-- 4. Privilege-escalation guard: with is_org_owner now including admins, the
-- org_members write policies would let an admin promote themselves to owner or
-- remove the owner. This trigger closes that: any row that IS or BECOMES an
-- owner row may only be touched by a true owner. Service-role writes
-- (auth.uid() null — team server actions, platform admin) are exempt, and the
-- very first member of a fresh org may be an owner (the org-creation trigger
-- bootstraps the creator before any membership exists).
create or replace function private.guard_org_member_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_touches_owner boolean;
begin
  if (select auth.uid()) is null then
    return coalesce(new, old); -- service role: app-level checks govern
  end if;

  v_org_id := coalesce(new.org_id, old.org_id);
  v_touches_owner :=
    (tg_op in ('INSERT', 'UPDATE') and new.role = 'owner')
    or (tg_op in ('UPDATE', 'DELETE') and old.role = 'owner');

  if not v_touches_owner then
    return coalesce(new, old);
  end if;

  -- bootstrap: the creator becomes the first owner of a brand-new org
  if tg_op = 'INSERT'
     and not exists (select 1 from public.org_members m where m.org_id = new.org_id) then
    return new;
  end if;

  if not private.is_org_true_owner(v_org_id) then
    raise exception 'only the account owner may manage owner memberships';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger org_members_guard_roles
  before insert or update or delete on public.org_members
  for each row execute function private.guard_org_member_roles();

-- 5. accept_invite copies the invite's permissions onto the membership. (The
-- current invite flow runs through service-role server actions, but the RPC
-- stays correct for any authenticated redeem path.)
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

  insert into public.org_members (org_id, user_id, role, permissions)
  values (v_invite.org_id, (select auth.uid()), v_invite.role, v_invite.permissions)
  on conflict (org_id, user_id) do nothing;

  update public.invites set accepted_at = now() where id = v_invite.id;

  return v_invite.org_id;
end;
$$;
