-- ============================================================================
-- Contact company + per-agent intake fields (owner request 2026-07-28)
--
-- contacts.company: the sender's/caller's company name. Restores the field the
-- legacy bridge had (docs/legacy-analysis.md §2.4/§2.7 — extraction schema
-- contact.company + HubSpot contact property `company`) which was dropped in
-- the v2 rebuild. Filled gap-only (never overwriting) by: the voice
-- create_ticket tool, the Phase-4 extraction (text pipeline + voice post-call),
-- and manual edits in the inbox sidebar.
--
-- agents.intake_fields: which contact fields a voice agent actively asks the
-- caller for during ticket intake (Name / Rückrufnummer / E-Mail / Unternehmen).
-- Subset of name|phone|email|company; the default mirrors the previously
-- hardcoded prompt behavior ("erfrage Name und Rückrufnummer"). Empty array =
-- ask nothing, only the request itself. Text agents ignore the column (their
-- contact data comes from extraction, not from asking).
--
-- RLS: both are columns on existing tables — the existing policies apply
-- (contacts: member writes; agents: owner/admin-only writes per 0011/0024).
-- ============================================================================

alter table public.contacts add column company text;

alter table public.agents add column intake_fields text[] not null
  default array['name', 'phone']::text[];

alter table public.agents add constraint agents_intake_fields_check
  check (intake_fields <@ array['name', 'phone', 'email', 'company']::text[]);
