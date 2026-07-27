-- Images in the knowledge base + an explicit release flag for outbound sending.
--
-- Two independent capabilities that share one column:
--
--  1. Images (jpg/png/gif/webp) become an indexable kb_sources.type='file'. No
--     schema change is needed for that: the worker describes the image once at
--     index time (Claude vision) and stores the description as an ordinary
--     kb_chunk, so retrieval, hybrid search and rerank keep working unchanged.
--
--  2. is_shareable answers a question the knowledge base could not express
--     before: "may the bot send this actual FILE to an end customer?" That is
--     strictly narrower than "may the bot use this content to answer", which is
--     already governed by which knowledge bases an agent is linked to. A price
--     list may inform an answer without ever being allowed to leave the org.
--
-- Default is false: nothing leaves the org until a human deliberately releases
-- it. Existing rows therefore stay closed after this migration.
alter table public.kb_sources
  add column is_shareable boolean not null default false;

-- Only uploaded files have bytes to send. url/text sources (and the is_learned
-- system source) can never be released — this keeps the flag from drifting into
-- a meaningless state and lets the UI show the switch only where it applies.
alter table public.kb_sources
  add constraint kb_sources_shareable_only_files
  check (not is_shareable or type = 'file');

-- Releasing a file for outbound sending is a privileged act: kb_sources rows are
-- member-writable (0001 kb_sources_all), so without this guard any Mitarbeiter
-- could mark an internal document as customer-sendable. Same owner-gating idea
-- as forms.notification_emails (0019) — and for the same reason: the column
-- decides whether org data reaches an outside recipient.
--
-- Service role (auth.uid() is null) stays unrestricted; the worker never flips
-- this column, but re-index/status writes must not trip the guard.
create or replace function private.guard_kb_sources_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' and new.is_shareable and not private.is_org_owner(new.org_id) then
    raise exception 'only owners may release a knowledge source for sending';
  end if;

  if tg_op = 'UPDATE'
     and new.is_shareable is distinct from old.is_shareable
     and not private.is_org_owner(new.org_id) then
    raise exception 'only owners may release a knowledge source for sending';
  end if;

  return new;
end;
$$;

create trigger kb_sources_guard
  before insert or update on public.kb_sources
  for each row execute function private.guard_kb_sources_row();

comment on column public.kb_sources.is_shareable is
  'Owner-gated: the bot may attach this file to an outbound customer reply. Content usage is governed separately by agent_knowledge_bases.';

-- Describing an image is an Anthropic call billed per (re-)index, unlike every
-- other indexing cost so far (OpenAI embeddings). Without its own category it
-- would have to hide under 'other' and become invisible in the cost breakdown.
-- usage_events writes are best-effort and swallow errors (usage.ts), so a
-- pre-migration worker never fails on this — it just loses the row.
alter table public.usage_events drop constraint usage_events_category_check;
alter table public.usage_events add constraint usage_events_category_check
  check (category in ('voice_minutes', 'index_embeddings', 'index_vision',
                      'whatsapp_message', 'email', 'sip_minutes', 'other'));
