-- Zendori v2 — 0003: chat widget sessions + reply broadcast
-- Anonymous widget visitors get a session bound to one conversation. The
-- session secret authorizes posting; the broadcast topic (unguessable) lets
-- the widget receive agent/bot replies via Supabase Realtime broadcast
-- without any auth user. Service-role only: RLS enabled, NO policies.

create table public.widget_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  conversation_id uuid not null unique references public.conversations (id) on delete cascade,
  secret_hash text not null,
  broadcast_topic text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index widget_sessions_channel_idx on public.widget_sessions (channel_id);

alter table public.widget_sessions enable row level security;
-- no policies on purpose: only the service role (widget API routes) may touch sessions

-- broadcast outbound messages (agent/bot replies) to the widget's topic
create or replace function private.broadcast_widget_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_topic text;
begin
  if new.direction = 'out' then
    select broadcast_topic into v_topic
    from public.widget_sessions
    where conversation_id = new.conversation_id;

    if v_topic is not null then
      perform realtime.send(
        jsonb_build_object(
          'id', new.id,
          'content', new.content,
          'content_type', new.content_type,
          'sender_type', new.sender_type,
          'created_at', new.created_at
        ),
        'reply',
        v_topic,
        false -- public topic: unguessable 48-hex secret is the access control
      );
    end if;
  end if;
  return new;
end;
$$;

create trigger on_message_created_widget
  after insert on public.messages
  for each row execute function private.broadcast_widget_reply();
