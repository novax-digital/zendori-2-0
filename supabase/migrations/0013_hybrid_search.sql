-- ============================================================================
-- Hybrid retrieval (owner request 2026-07-14): vector + keyword search fused
-- via Reciprocal Rank Fusion, as the first stage of a two-stage funnel
-- (stage 2 = Haiku reranking in packages/ai — no DB part).
--
--   · kb_chunks.fts: generated tsvector (german stemming) + GIN index
--   · hybrid_kb_search(): vector leg (semantic) + keyword leg (exact terms,
--     product names, error codes) → RRF-fused candidate pool
--   · NEW function name on purpose: the worker falls back to the existing
--     match_kb_chunks when this function is absent (worker-ahead-of-migration
--     skew stays safe — learned from the 0012 review)
--   · ai_runs.step gains 'rerank' (stage-2 cost/latency logging)
--
-- The keyword leg uses websearch_to_tsquery (AND semantics): short queries
-- (chat, voice, subjects) benefit most; a long e-mail body simply yields an
-- empty keyword leg and the fusion degrades to vector-only — never worse
-- than before.
-- ============================================================================

alter table public.kb_chunks
  add column fts tsvector
  generated always as (to_tsvector('german', content)) stored;

create index kb_chunks_fts_idx on public.kb_chunks using gin (fts);

-- stage-2 logging
alter table public.ai_runs drop constraint ai_runs_step_check;
alter table public.ai_runs add constraint ai_runs_step_check
  check (step in ('classify', 'extract', 'retrieve', 'rerank', 'draft'));

-- Hybrid candidate search. Returns `similarity` = RRF score (NOT cosine) so
-- the existing KbChunkMatch shape keeps working; ordering is what matters.
-- p_knowledge_base_ids: null = all bases of the org, [] = nothing (agent
-- without linked bases). Same recall caveat as match_kb_chunks (0012) on the
-- vector leg; the keyword leg (GIN) is exact and does not share it.
create or replace function public.hybrid_kb_search(
  p_org_id uuid,
  p_query text,
  p_embedding extensions.vector(1536),
  p_match_count integer default 24,
  p_knowledge_base_ids uuid[] default null
)
returns table (id uuid, source_id uuid, content text, similarity double precision)
language sql
stable
as $$
  with vec as (
    select
      c.id,
      row_number() over (
        order by c.embedding operator(extensions.<=>) p_embedding
      ) as rank
    from public.kb_chunks c
    where c.org_id = p_org_id
      and c.embedding is not null
      and (
        p_knowledge_base_ids is null
        or exists (
          select 1 from public.kb_sources s
          where s.id = c.source_id
            and s.knowledge_base_id = any (p_knowledge_base_ids)
        )
      )
      -- looser gate than the legacy 0.3: the reranker (stage 2) filters noise
      and 1 - (c.embedding operator(extensions.<=>) p_embedding) >= 0.15
    order by c.embedding operator(extensions.<=>) p_embedding
    limit greatest(p_match_count, 1)
  ),
  kw as (
    select
      c.id,
      row_number() over (
        order by ts_rank_cd(c.fts, websearch_to_tsquery('german', p_query)) desc
      ) as rank
    from public.kb_chunks c
    where p_query <> ''
      and c.org_id = p_org_id
      and c.fts @@ websearch_to_tsquery('german', p_query)
      and (
        p_knowledge_base_ids is null
        or exists (
          select 1 from public.kb_sources s
          where s.id = c.source_id
            and s.knowledge_base_id = any (p_knowledge_base_ids)
        )
      )
    order by ts_rank_cd(c.fts, websearch_to_tsquery('german', p_query)) desc
    limit greatest(p_match_count, 1)
  ),
  fused as (
    -- Reciprocal Rank Fusion (k=50): robust rank-based merge, no score scaling
    select
      coalesce(vec.id, kw.id) as id,
      coalesce(1.0 / (50 + vec.rank), 0) + coalesce(1.0 / (50 + kw.rank), 0) as score
    from vec
    full outer join kw on vec.id = kw.id
  )
  select c.id, c.source_id, c.content, f.score as similarity
  from fused f
  join public.kb_chunks c on c.id = f.id
  order by f.score desc, c.id
  limit greatest(p_match_count, 1);
$$;
