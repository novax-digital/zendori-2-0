-- ============================================================================
-- Multiple knowledge bases, linkable to agents n:m (owner request 2026-07-14)
--
-- Until now RAG searched ALL kb_chunks of the org. Now sources are grouped
-- into named knowledge bases, and each agent is linked to the bases it may
-- use — the chat agent can know different things than the e-mail agent.
--   · knowledge_bases: content containers (managed by members, like kb_sources)
--   · kb_sources.knowledge_base_id: every source belongs to exactly one base
--   · agent_knowledge_bases: n:m link (owner-only — it changes bot behavior)
--   · match_kb_chunks gains an optional base filter:
--       NULL  = search everything (force-draft / agent-less contexts)
--       {}    = search nothing (an agent with no linked bases knows nothing)
-- Backfill: one default base per org holding all existing sources, linked to
-- all existing agents — behavior-preserving.
--
-- ROLLOUT ORDER: commit/push the app diff FIRST (build ready), then db push,
-- then deploy web immediately — the pre-0012 web inserts kb_sources without
-- knowledge_base_id (NOT NULL violation) once this migration is live. The
-- worker is skew-safe in both directions (retrieve omits the new RPC arg when
-- unfiltered; 42P01 on the link table degrades to all-org knowledge).
-- ============================================================================

create table public.knowledge_bases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  -- composite target so kb_sources / agent links can enforce same-org via FK
  unique (id, org_id)
);

create index knowledge_bases_org_idx on public.knowledge_bases (org_id);

alter table public.knowledge_bases enable row level security;

-- Content management stays member-level (same trust as kb_sources_all):
-- members curate knowledge; only the agent LINKING below is owner-only.
create policy knowledge_bases_all on public.knowledge_bases
  for all to authenticated
  using (private.is_org_member(org_id))
  with check (private.is_org_member(org_id));

-- --- every source belongs to one base ---------------------------------------

alter table public.kb_sources add column knowledge_base_id uuid;

-- Same-org enforced by the composite FK; deleting a base deletes its sources
-- (kb_chunks cascade off kb_sources).
alter table public.kb_sources
  add constraint kb_sources_kb_same_org
  foreign key (knowledge_base_id, org_id)
  references public.knowledge_bases (id, org_id) on delete cascade;

create index kb_sources_kb_idx on public.kb_sources (knowledge_base_id);

-- Backfill: a default base per org, then attach all existing sources.
insert into public.knowledge_bases (org_id, name, description)
select o.id, 'Allgemein', 'Automatisch angelegt — enthält alle bestehenden Quellen.'
from public.organizations o;

update public.kb_sources s
set knowledge_base_id = kb.id
from public.knowledge_bases kb
where kb.org_id = s.org_id
  and kb.name = 'Allgemein'
  and s.knowledge_base_id is null;

alter table public.kb_sources alter column knowledge_base_id set not null;

-- --- agent ↔ knowledge base links (n:m) ---------------------------------------

create table public.agent_knowledge_bases (
  org_id uuid not null,
  agent_id uuid not null,
  knowledge_base_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (agent_id, knowledge_base_id),
  foreign key (agent_id, org_id)
    references public.agents (id, org_id) on delete cascade,
  foreign key (knowledge_base_id, org_id)
    references public.knowledge_bases (id, org_id) on delete cascade
);

create index agent_knowledge_bases_org_idx on public.agent_knowledge_bases (org_id);
create index agent_knowledge_bases_kb_idx on public.agent_knowledge_bases (knowledge_base_id);

alter table public.agent_knowledge_bases enable row level security;

-- Linking decides what an agent knows → owner-only writes, member reads
-- (mirrors the agents table; both FK targets enforce same-org rows).
create policy agent_kbs_select on public.agent_knowledge_bases
  for select to authenticated using (private.is_org_member(org_id));
create policy agent_kbs_insert on public.agent_knowledge_bases
  for insert to authenticated with check (private.is_org_owner(org_id));
create policy agent_kbs_delete on public.agent_knowledge_bases
  for delete to authenticated using (private.is_org_owner(org_id));

-- Backfill: link every existing agent to its org's default base (pre-0012 every
-- agent searched all org chunks — this preserves that).
insert into public.agent_knowledge_bases (org_id, agent_id, knowledge_base_id)
select a.org_id, a.id, kb.id
from public.agents a
join public.knowledge_bases kb on kb.org_id = a.org_id and kb.name = 'Allgemein';

-- Orgs created AFTER this migration also start with a default base (otherwise
-- an agent created before the first base would stay unlinked and know nothing).
-- Extends the 0001 trigger; keeps membership + org_settings behavior unchanged.
create or replace function private.handle_new_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    insert into public.org_members (org_id, user_id, role)
    values (new.id, (select auth.uid()), 'owner');
  end if;
  insert into public.org_settings (org_id) values (new.id);
  insert into public.knowledge_bases (org_id, name, description)
  values (new.id, 'Allgemein', 'Automatisch angelegt.');
  return new;
end;
$$;

-- --- RAG match function with base filter ---------------------------------------

-- Adding a parameter changes the signature: drop the old overload first so
-- PostgREST rpc name resolution stays unambiguous.
drop function public.match_kb_chunks(uuid, extensions.vector, double precision, integer);

-- RECALL CAVEAT (reviewed, accepted): the org/base predicates are POST-filters
-- on the hnsw candidate stream (ef_search=40) — at large chunk counts an agent
-- linked to a small base could see fewer/zero matches although qualifying
-- chunks exist. The fix (pgvector iterative_scan) cannot be attached as a
-- function-level SET on Supabase (placeholder GUC, superuser-only) — revisit
-- with the planned hybrid-search/reranking upgrade or once orgs exceed ~10k
-- chunks. At current scale the planner does not even use the index.
create or replace function public.match_kb_chunks(
  p_org_id uuid,
  p_embedding extensions.vector(1536),
  p_match_threshold double precision default 0.3,
  p_match_count integer default 6,
  p_knowledge_base_ids uuid[] default null
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
    -- NULL = unfiltered (all org knowledge); [] = nothing (agent without bases)
    and (
      p_knowledge_base_ids is null
      or exists (
        select 1 from public.kb_sources s
        where s.id = c.source_id
          and s.knowledge_base_id = any (p_knowledge_base_ids)
      )
    )
    and 1 - (c.embedding operator(extensions.<=>) p_embedding) >= p_match_threshold
  order by c.embedding operator(extensions.<=>) p_embedding
  limit greatest(p_match_count, 1);
$$;
