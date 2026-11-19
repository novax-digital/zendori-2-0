-- Zendori v2 — 0032: Demo-Anrufe (lead capture + outbound voice demo)
--
-- One row per demo-call request from the public embed (demo.js, phone
-- verification by SMS/voice code via Twilio Verify) or the internal admin demo
-- (/admin/demo, no verification).
-- Operator-level data: the demo belongs to the Zendori operator, not to a
-- tenant, so this table deliberately has NO org_id (documented exception to
-- CLAUDE.md §5, see docs/demo-call.md). Leads live only here (+ the sales
-- notification mail) — never as contacts/conversations in an org.
--
-- Access: service role only. RLS is enabled with NO policies, so anon and
-- authenticated clients can neither read nor write. The public web routes,
-- the admin area (requirePlatformAdmin, then the service role) and the worker
-- all use the service role.
--
-- Lifecycle (status):
--   awaiting_confirmation → queued        (public: correct SMS/voice code entered in the embed)
--   queued                                (admin demos start here)
--   queued → preparing → dialing          (worker: website summary, Twilio call)
--   dialing → connecting                  (xAI webhook: the lead answered, SIP bridged)
--   connecting → in_call                  (worker joined the xAI WebSocket)
--   → completed | no_answer | busy | failed | expired

create table public.demo_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null check (source in ('public', 'admin')),

  -- lead data (validated at the boundary, stored as entered)
  company_name text not null check (char_length(company_name) between 1 and 120),
  contact_name text not null check (char_length(contact_name) between 1 and 120),
  email text check (email is null or char_length(email) <= 200),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  website_url text check (website_url is null or char_length(website_url) <= 300),
  prompt text not null default '' check (char_length(prompt) <= 1000),

  -- consent + phone verification (public requests only). The code itself is
  -- generated, delivered and checked by Twilio Verify — never stored here; the
  -- columns only bound deliveries/attempts. The status token is stored as a
  -- sha256 hash; the plain value exists only in the embed.
  consent_at timestamptz,
  consent_version text,
  verify_channel text check (verify_channel is null or verify_channel in ('sms', 'call')),
  verify_sends integer not null default 0,
  verify_last_sent_at timestamptz,
  verify_attempts integer not null default 0,
  verify_expires_at timestamptz,
  confirmed_at timestamptz,
  status_token_hash text unique,
  client_request_id uuid unique,
  ip_hash text,
  requested_by uuid references auth.users (id) on delete set null,

  -- lifecycle
  status text not null check (status in (
    'awaiting_confirmation', 'queued', 'preparing', 'dialing', 'connecting', 'in_call',
    'completed', 'no_answer', 'busy', 'failed', 'expired'
  )),
  status_detail text,
  website_summary text,
  twilio_call_sid text unique,
  provider_call_id text unique,
  dialed_at timestamptz,
  claimed_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  transcript jsonb not null default '[]'::jsonb,

  -- sales notification (public leads, once per terminal call)
  notified_at timestamptz,
  notify_attempts integer not null default 0,

  constraint demo_calls_public_consent check (
    source <> 'public' or (consent_at is not null and email is not null)
  )
);

-- worker sweep + caps: only the non-terminal rows are hot
create index demo_calls_active_idx on public.demo_calls (status, created_at)
  where status in ('awaiting_confirmation', 'queued', 'preparing', 'dialing', 'connecting', 'in_call');
-- per-number cap (web) + admin list ordering
create index demo_calls_phone_idx on public.demo_calls (phone_e164, created_at);
create index demo_calls_created_idx on public.demo_calls (created_at desc);
-- pending sales notifications
create index demo_calls_notify_idx on public.demo_calls (ended_at)
  where notified_at is null and source = 'public';

alter table public.demo_calls enable row level security;
-- intentionally no policies: service role only

-- Worker wake-up: a broadcast on the private 'demo-dispatch' topic when a row
-- becomes 'queued' (start dialing) or 'connecting' (join the call NOW — the
-- lead is already on the line). Ids/status only, never lead data (§7). The
-- worker's 2s sweep is the at-most-once fallback.
create or replace function private.notify_demo_call()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('queued', 'connecting')
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform realtime.send(
      jsonb_build_object('demo_call_id', new.id, 'status', new.status),
      'demo_call',
      'demo-dispatch',
      true
    );
  end if;
  return new;
end;
$$;

create trigger on_demo_call_status
  after insert or update of status on public.demo_calls
  for each row execute function private.notify_demo_call();
