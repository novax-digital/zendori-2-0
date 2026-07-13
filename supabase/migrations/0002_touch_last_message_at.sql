-- Zendori v2 — 0002: keep conversations.last_message_at fresh
-- Every writer (inbox actions, webhooks, worker, test channel) inserts into
-- messages; a trigger guarantees the invariant no matter who writes.

create or replace function private.touch_conversation_on_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
  set last_message_at = new.created_at
  where id = new.conversation_id
    and (last_message_at is null or last_message_at < new.created_at);
  return new;
end;
$$;

create trigger on_message_created
  after insert on public.messages
  for each row execute function private.touch_conversation_on_message();
