-- Zendori v2 — 0007: HubSpot one-way sync scheduling state (Phase 6)
-- The HubSpot ticket id lives in conversations.external_refs.hubspot_ticket_id
-- (§5). Sync scheduling uses two timestamps so a re-request that arrives while
-- the worker is mid-sync is never lost (dirty-flag via monotonic timestamps):
--   requested_at  — set when a sync is due (worker after pipeline / manual
--                   button / status change)
--   synced_at     — set by the worker when a sync completes successfully
-- A conversation is "due" when requested_at is set and synced_at is older
-- (or null). A new request bumps requested_at past synced_at → re-picked.

alter table public.conversations
  add column hubspot_sync_requested_at timestamptz,
  add column hubspot_synced_at timestamptz;

-- Scan support: bounds the poll to conversations that have ever requested a sync.
create index conversations_hubspot_sync_due_idx
  on public.conversations (hubspot_sync_requested_at)
  where hubspot_sync_requested_at is not null;
