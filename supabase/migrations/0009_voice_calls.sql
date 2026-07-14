-- Zendori v2 — 0009: voice calls + worker dispatch broadcast (Phase 9)
--
-- One row per inbound xAI voice call. The Vercel webhook (/api/hooks/voice)
-- inserts it; an AFTER INSERT trigger pushes a broadcast on the private
-- 'voice-dispatch' topic so the ingress-free worker (Supabase Realtime
-- subscriber, service role) can claim the call and join the xAI WebSocket
-- within ~1s. Mirrors the 0003 widget broadcast pattern; the 3s scan sweep is
-- the at-most-once fallback.

create table public.voice_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- xAI call_id: idempotency key + the worker's WebSocket join key
  provider_call_id text not null unique,
  from_number text,
  to_number text not null,
  status text not null default 'ringing'
    check (status in ('ringing', 'connecting', 'active', 'completed', 'missed', 'failed', 'transferred')),
  claimed_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  ended_reason text,
  -- stamped by the voice.post-call pipeline (classify/extract over the transcript);
  -- the scan enqueues ended calls where this is null
  post_processed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index voice_calls_ringing_idx on public.voice_calls (created_at) where status = 'ringing';
create index voice_calls_post_call_idx on public.voice_calls (ended_at)
  where post_processed_at is null and ended_at is not null;
create index voice_calls_conversation_idx on public.voice_calls (conversation_id);
create index voice_calls_org_idx on public.voice_calls (org_id);

-- RLS: members may read call metadata (inbox shows duration/status); all writes
-- go through the service role (web hook + worker) — no write policies.
alter table public.voice_calls enable row level security;

create policy voice_calls_select on public.voice_calls
  for select to authenticated using (private.is_org_member(org_id));

-- Dispatch broadcast: metadata/ids only, never content (§7). Private topic —
-- only authorized subscribers (the worker's service-role Realtime client).
create or replace function private.notify_voice_call()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'voice_call_id', new.id,
      'provider_call_id', new.provider_call_id,
      'org_id', new.org_id,
      'channel_id', new.channel_id
    ),
    'incoming_call',
    'voice-dispatch',
    true
  );
  return new;
end;
$$;

create trigger on_voice_call_created
  after insert on public.voice_calls
  for each row execute function private.notify_voice_call();
