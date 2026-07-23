-- ============================================================================
-- Learning loop "Gelernte Antworten" (owner request 2026-07-23): the agent gets
-- smarter from human answers WITHOUT model training — human replies after a
-- handoff and materially edited drafts become PII-free, generalized Q&A pairs
-- that a human approves into a per-org "Gelernte Antworten" knowledge source.
-- The worker COMPILES that source directly from the approved rows at index time
-- (no storage file), so approvals just poke the source to 'pending'.
--
--   candidate  → written by apps/web when a human reply qualifies (row is a
--                marker only; question/answer are still null)
--   proposed   → worker distilled a generalized, PII-free pair (Haiku)
--   auto_rejected → worker judged it not worth learning (smalltalk, one-off)
--   approved   → human reviewed (and possibly edited) the pair; the learned
--                source is re-indexed from all approved rows
--   rejected   → human declined the proposal
--   error      → distillation failed terminally (kept visible, retryable)
--
-- DSGVO: question/answer are generalized and PII-stripped at distillation time
-- (prompt-enforced), a human approves before anything reaches the knowledge
-- base, rows are org-scoped (RLS) and cascade-deleted with the org (§7).
-- ============================================================================

-- Same-org composite-FK targets (0011/0019 pattern): a member must not be able
-- to reference ANOTHER org's message/conversation from a learned_answers row —
-- the worker would otherwise distill foreign conversation content into the
-- member's org (cross-tenant exfiltration). Both tables are small at this stage;
-- the unique indexes build quickly.
alter table public.messages add constraint messages_id_org_unique unique (id, org_id);
alter table public.conversations add constraint conversations_id_org_unique unique (id, org_id);

create table public.learned_answers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  -- provenance (nullable: learning must survive conversation/message cleanup —
  -- an APPROVED pair keeps feeding the knowledge source even when its origin
  -- message is deleted, hence SET NULL, never CASCADE)
  conversation_id uuid,
  -- the human reply message that triggered the candidate — idempotency anchor
  -- (unique allows multiple NULLs after the origin message was deleted)
  message_id uuid unique,
  origin text not null check (origin in ('handoff_resolution', 'draft_correction')),
  status text not null default 'candidate'
    check (status in ('candidate', 'proposed', 'auto_rejected', 'approved', 'rejected', 'error')),
  -- distilled pair (null until the worker processed the candidate)
  question text,
  answer text,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  -- a pair shown to or approved by a human must actually exist
  constraint learned_answers_pair_present
    check (status not in ('proposed', 'approved') or (question is not null and answer is not null)),
  -- same-org guarantees via composite FKs; the column list on SET NULL (PG15+,
  -- proven in 0011) nulls only the reference, never org_id
  constraint learned_answers_message_fk
    foreign key (message_id, org_id) references public.messages (id, org_id)
    on delete set null (message_id),
  constraint learned_answers_conversation_fk
    foreign key (conversation_id, org_id) references public.conversations (id, org_id)
    on delete set null (conversation_id)
);

-- worker poll (1s scan): tiny partial index keeps the candidate lookup free
create index learned_answers_candidate_idx
  on public.learned_answers (created_at)
  where status = 'candidate';
-- review UI + learned-source compilation: list per org and status
create index learned_answers_org_status_idx
  on public.learned_answers (org_id, status, created_at);
-- FK maintenance: conversation deletes must not seq-scan the table
create index learned_answers_conversation_idx
  on public.learned_answers (conversation_id);

alter table public.learned_answers enable row level security;

-- Content management is member-level, like kb_sources (§5): members create
-- candidates from the inbox, review proposals and decide. The worker uses the
-- service role and bypasses RLS.
create policy learned_answers_all on public.learned_answers
  for all to authenticated
  using (private.is_org_member(org_id)) with check (private.is_org_member(org_id));

-- The per-org learned-answers source is a SYSTEM source: marked explicitly
-- (never collides with user uploads, whatever their filename) and unique per
-- org (closes the concurrent-first-approval create race).
alter table public.kb_sources add column is_learned boolean not null default false;
create unique index kb_sources_learned_source_per_org_idx
  on public.kb_sources (org_id)
  where is_learned;

-- ai_runs steps: add 'learn' (distillation cost/latency logging) — and repair a
-- latent gap: the transcribe step (WhatsApp voice notes, 2026-07-21) logs
-- step='transcribe', which the 0013 constraint never allowed; every voice note
-- burned one pg-boss retry on the failed insert before succeeding idempotently.
alter table public.ai_runs drop constraint ai_runs_step_check;
alter table public.ai_runs add constraint ai_runs_step_check
  check (step in ('transcribe', 'classify', 'extract', 'retrieve', 'rerank', 'draft', 'learn'));
