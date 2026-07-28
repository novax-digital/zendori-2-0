-- ============================================================================
-- Inbox search (owner request 2026-07-28)
--
-- search_conversations: org-scoped substring search over conversation subject,
-- contact identity fields (name/email/phone/company — company since 0027) and
-- message contents. Substring ILIKE instead of the german-stemmed FTS used for
-- kb_chunks (0013): inbox search is "find that conversation" — partial words,
-- e-mail fragments and phone digits must match, which stemming would break.
--
-- SECURITY INVOKER (0005/0013 pattern): the function runs with the caller's
-- rights, so RLS on conversations/contacts/messages applies — an authenticated
-- member can only ever search rows of orgs they belong to. The 0024 Mitarbeiter
-- channel scope is app-level, not RLS — the caller passes it via p_channel_ids
-- (null = unrestricted), same contract as listConversations.
--
-- The ILIKE needle escapes \ % _ so user input always matches literally.
-- No pg_trgm/GIN indexes yet: per-org row counts are small; when volumes grow,
-- enable pg_trgm and add GIN trgm indexes on messages.content and
-- conversations.subject without touching this function's contract.
-- ============================================================================

create or replace function public.search_conversations(
  p_org_id uuid,
  p_query text,
  p_status text default null,
  p_channel_ids uuid[] default null,
  p_limit integer default 100
)
returns table (id uuid)
language sql
stable
set search_path = public
as $$
  with needle as (
    select
      '%'
      || replace(replace(replace(trim(coalesce(p_query, '')), '\', '\\'), '%', '\%'), '_', '\_')
      || '%' as pat
  )
  select c.id
  from conversations c
  left join contacts ct on ct.id = c.contact_id and ct.org_id = c.org_id
  cross join needle n
  where c.org_id = p_org_id
    and length(trim(coalesce(p_query, ''))) > 0
    and (p_status is null or c.status = p_status)
    and (p_channel_ids is null or c.channel_id = any (p_channel_ids))
    and (
      c.subject ilike n.pat
      or ct.name ilike n.pat
      or ct.email ilike n.pat
      or ct.phone ilike n.pat
      or ct.company ilike n.pat
      or exists (
        select 1
        from messages m
        where m.conversation_id = c.id
          and m.content ilike n.pat
      )
    )
  order by c.last_message_at desc nulls last
  limit least(greatest(coalesce(p_limit, 100), 1), 100);
$$;
