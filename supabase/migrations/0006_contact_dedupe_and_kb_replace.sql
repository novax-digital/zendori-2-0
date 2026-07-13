-- Zendori v2 — 0006: contact dedupe backstop + atomic KB chunk replace (Phase 4 hardening)

-- ============================================================================
-- contacts: DB-level uniqueness backstop for find-or-create by email
-- ============================================================================
-- The worker (extraction), the widget, and the test channel all find-or-create
-- contacts by (org_id, lower(email)); without a unique constraint a race can
-- create duplicates. Partial unique (email may be null for anonymous contacts).
create unique index if not exists contacts_org_email_unique_idx
  on public.contacts (org_id, lower(email))
  where email is not null;

-- ============================================================================
-- atomic KB chunk replace (reindex without a transient empty-KB window)
-- ============================================================================
-- Replaces a source's chunks in a single transaction: a concurrent RAG query
-- never sees the source with zero chunks, and a failed insert never destroys
-- the prior index (the whole function rolls back). Service-role only (worker).
create or replace function public.replace_kb_chunks(
  p_source_id uuid,
  p_org_id uuid,
  p_chunks jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.kb_chunks where source_id = p_source_id and org_id = p_org_id;

  insert into public.kb_chunks (org_id, source_id, content, embedding, token_count)
  select
    p_org_id,
    p_source_id,
    (elem ->> 'content')::text,
    (elem ->> 'embedding')::extensions.vector(1536),
    (elem ->> 'token_count')::integer
  from jsonb_array_elements(p_chunks) as elem;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- callable by the service role only (no grant to authenticated/anon)
revoke all on function public.replace_kb_chunks(uuid, uuid, jsonb) from public, anon, authenticated;
