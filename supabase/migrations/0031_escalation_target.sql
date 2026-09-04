-- ============================================================================
-- Phase 12 (owner decision 2026-09-04): escalation target per agent +
-- attach rule v2
--
-- agents.escalation_target: what an escalation (escalation keyword, customer
-- wants a human, intake, low confidence with handoff_enabled) DOES.
--   'human' = live handoff (mode='human', status='pending'; voice transfer or
--             callback) — today's behavior, the default
--   'ticket' = open a ticket, confirm it to the customer, the bot stays in
--              control (no mode/status flip; voice never transfers) — for orgs
--              without a human team
-- handoff_enabled keeps its column and now reads "also escalate on low
-- confidence" (the target decides what the escalation does).
--
-- org_settings.ticket_ack_texts: ticket confirmation texts for target 'ticket'
-- ({enabled, in_hours, out_of_hours}, placeholder {ticket_id}); '{}' = enabled
-- with the built-in default text (packages/channels business-hours.ts).
--
-- Attach rule v2: a conversation may carry SEVERAL non-resolved tickets — an
-- escalation attaches to the newest one only when the message is not a topic
-- change and that ticket is younger than 24h (ensureTicket in packages/core),
-- otherwise it opens a new one. The 0030 partial unique index enforced the old
-- "one open ticket per conversation" rule and must go. tickets_conversation_idx
-- (conversation_id, opened_at desc) serves the "newest open" lookup.
--
-- RLS: columns on existing tables — existing policies apply (agents: owner/
-- admin writes per 0011/0024; org_settings: owner/admin update). Rollout: safe
-- in either order (code tolerates the missing columns; with the index still
-- present a second ticket insert hits 23505 and attaches — today's behavior).
-- ============================================================================

alter table public.agents
  add column escalation_target text not null default 'human'
    constraint agents_escalation_target_check check (escalation_target in ('human', 'ticket'));

alter table public.org_settings
  add column ticket_ack_texts jsonb not null default '{}'::jsonb;

drop index if exists public.tickets_open_per_conversation_idx;
