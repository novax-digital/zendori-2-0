-- ============================================================================
-- Contact callback phone (owner request 2026-09-03)
--
-- contacts.phone is the caller identity: the voice webhook finds-or-creates
-- the contact by the SIP From number, so overwriting it with a callback
-- number the caller states on the phone would break matching on the next call
-- (a duplicate contact per call). A stated callback number that differs from
-- the caller id therefore gets its own column.
--
-- Semantics: set by the voice create_ticket tool (latest statement wins — the
-- caller explicitly says where they can be reached), editable in the inbox
-- sidebar, mapped to HubSpot `mobilephone`. Anonymous callers (phone null)
-- get the stated number as `phone` instead (gap-fill), not here.
--
-- RLS: column on an existing table — the existing member-write policies apply.
-- ============================================================================

alter table public.contacts add column callback_phone text;
