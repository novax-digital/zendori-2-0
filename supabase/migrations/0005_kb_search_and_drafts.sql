-- Zendori v2 — 0005: KB vector search, AI drafts, KB file storage (Phase 4)

-- ============================================================================
-- KB vector search (RAG retrieval)
-- ============================================================================
-- security invoker (default): RLS on kb_chunks already scopes authenticated
-- callers to their own org; the worker uses the service role (bypasses RLS)
-- and passes p_org_id explicitly. Cosine distance (<=>) uses the hnsw index.
create or replace function public.match_kb_chunks(
  p_org_id uuid,
  p_embedding extensions.vector(1536),
  p_match_threshold double precision default 0.3,
  p_match_count integer default 6
)
returns table (id uuid, source_id uuid, content text, similarity double precision)
language sql
stable
as $$
  select
    c.id,
    c.source_id,
    c.content,
    1 - (c.embedding operator(extensions.<=>) p_embedding) as similarity
  from public.kb_chunks c
  where c.org_id = p_org_id
    and c.embedding is not null
    and 1 - (c.embedding operator(extensions.<=>) p_embedding) >= p_match_threshold
  order by c.embedding operator(extensions.<=>) p_embedding
  limit greatest(p_match_count, 1);
$$;

-- ============================================================================
-- AI drafts (suggested replies — Phase 4: never auto-sent)
-- ============================================================================
create table public.ai_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- the inbound message that triggered the draft (for idempotency / provenance)
  message_id uuid references public.messages (id) on delete set null,
  content text not null,
  confidence numeric not null default 0 check (confidence >= 0 and confidence <= 1),
  -- [{ source_id, uri, snippet }] — provenance for the RAG answer
  sources jsonb not null default '[]'::jsonb,
  model text not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'edited', 'discarded')),
  created_at timestamptz not null default now()
);

create index ai_drafts_conversation_idx on public.ai_drafts (conversation_id, created_at desc);
-- at most one pending draft per conversation (worker supersedes the old one first)
create unique index ai_drafts_one_pending_idx
  on public.ai_drafts (conversation_id)
  where status = 'pending';

alter table public.ai_drafts enable row level security;

-- org members read drafts and update their status (accept / edit / discard);
-- inserts are service-role only (the worker writes them)
create policy ai_drafts_select on public.ai_drafts
  for select to authenticated using (private.is_org_member(org_id));
create policy ai_drafts_update on public.ai_drafts
  for update to authenticated using (private.is_org_member(org_id))
  with check (private.is_org_member(org_id));

-- ============================================================================
-- KB file storage (uploaded PDF/DOCX → text in the worker)
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('kb-files', 'kb-files', false)
on conflict (id) do nothing;

-- path convention: <org_id>/<source_id>/<filename>; org members may read,
-- writes are service-role only (web uploads via the admin client)
create policy zendori_kb_files_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'kb-files'
    and private.is_org_member(((storage.foldername(name))[1])::uuid)
  );

-- ============================================================================
-- realtime: drafts appear in the inbox live
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.ai_drafts;
  end if;
end;
$$;
