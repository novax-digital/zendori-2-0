-- ============================================================================
-- Platform admins (Zendori superadmins)
--
-- A small allow-list of Zendori-internal users who manage customers across all
-- organizations. The /admin area gates on this table and then uses the service
-- role for cross-tenant reads/writes — so we deliberately do NOT add
-- platform-admin bypass policies to every tenant table.
-- ============================================================================

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

-- A signed-in user may read ONLY their own row, to detect their own admin
-- status (used by requirePlatformAdmin and the sidebar). There are deliberately
-- NO insert/update/delete policies: clients can never self-promote; membership
-- is managed exclusively by the service role (which bypasses RLS).
create policy platform_admins_select_self on public.platform_admins
  for select to authenticated using (user_id = (select auth.uid()));

-- Seed the founding Zendori admin if that auth user already exists. Idempotent
-- and safe when the user is absent (nothing inserted; add later via service role).
insert into public.platform_admins (user_id)
select id from auth.users where email = 'p.polley@novax-digital.de'
on conflict (user_id) do nothing;
