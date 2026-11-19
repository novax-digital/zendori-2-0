-- Zendori v2 — 0034: Kontaktanfragen (contact form on zendori.ai)
--
-- One row per message from the public contact form (contact.js embed on the
-- marketing site). Operator-level data like demo_calls (0032): the requests
-- belong to the Zendori operator, not to a tenant, so this table deliberately
-- has NO org_id (documented exception to CLAUDE.md §5, see
-- docs/contact-requests.md). Requests live only here (+ the notification mail
-- to the operator inbox) — never as contacts/conversations in an org.
--
-- Access: service role only. RLS is enabled with NO policies, so anon and
-- authenticated clients can neither read nor write. The public web route and
-- the admin area (requirePlatformAdmin, then the service role) use the
-- service role.
--
-- Lifecycle (status): new → in_progress → done (set by a platform admin under
-- Plattform → Kontaktanfragen; any direction is allowed).

create table public.contact_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- what the visitor entered (validated at the boundary, stored as entered)
  name text not null check (char_length(name) between 1 and 120),
  email text not null check (char_length(email) between 3 and 200),
  company text check (company is null or char_length(company) <= 120),
  phone text check (phone is null or char_length(phone) <= 40),
  topic text not null default 'general'
    check (topic in ('general', 'demo', 'pricing', 'support', 'partner')),
  message text not null check (char_length(message) between 1 and 4000),

  -- consent + abuse protection
  consent_at timestamptz not null,
  consent_version text not null,
  -- idempotency: one id per filled form, a retried submit never creates a second row
  client_request_id uuid not null unique,
  ip_hash text,

  -- handling by the operator
  status text not null default 'new' check (status in ('new', 'in_progress', 'done')),
  note text not null default '' check (char_length(note) <= 2000),
  handled_by uuid references auth.users (id) on delete set null,
  handled_at timestamptz,

  -- notification mail to the operator inbox (null = not sent yet / failed)
  notified_at timestamptz
);

-- admin list: newest first, filtered by status
create index contact_requests_created_idx on public.contact_requests (created_at desc);
create index contact_requests_status_idx on public.contact_requests (status, created_at desc);

alter table public.contact_requests enable row level security;
-- intentionally no policies: service role only
