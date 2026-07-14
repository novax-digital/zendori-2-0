-- ============================================================================
-- Review fixes for the 0013 hybrid search (all six confirmed findings share
-- one root cause: the loosened 0.15 vector gate is only safe WITH the stage-2
-- reranker, but some paths run without it):
--   · p_min_similarity: callers without a rerank stage (voice live calls)
--     restore the legacy 0.3 noise cutoff; the text pipeline keeps 0.15 +
--     rerank-always (code side).
--   · keyword leg gets a minimal semantic floor (0.10): pure lexical accidents
--     (stopword-adjacent matches with no semantic relation) can no longer tie
--     against strong vector hits in the RRF fusion. Genuine exact-term hits
--     (product codes) score well above 0.10 against their own question.
-- Signature change ⇒ drop + recreate (PostgREST overload resolution). Callers
-- omit p_min_similarity unless set, so 5-key bodies keep resolving; a 6-key
-- body against the pre-0014 function 404s into the legacy vector fallback —
-- which for voice is exactly the desired 0.3 behavior.
-- ============================================================================

drop function public.hybrid_kb_search(uuid, text, extensions.vector, integer, uuid[]);

create or replace function public.hybrid_kb_search(
  p_org_id uuid,
  p_query text,
  p_embedding extensions.vector(1536),
  p_match_count integer default 24,
  p_knowledge_base_ids uuid[] default null,
  p_min_similarity double precision default 0.15
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
      -- caller-controlled gate: 0.15 with a rerank stage, 0.3 without (voice)
      and 1 - (c.embedding operator(extensions.<=>) p_embedding) >= p_min_similarity
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
      -- minimal semantic floor: keeps genuine exact-term hits, drops lexical
      -- accidents with no semantic relation to the question
      and c.embedding is not null
      and 1 - (c.embedding operator(extensions.<=>) p_embedding) >= 0.10
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
