-- Zendori v2 — 0033: automatic phone-number provisioning (Admin → Telefonnummern)
--
-- Replaces the operator CLI step (scripts/provision-voice-number.ts --request)
-- with an admin button + worker job. The worker (apps/worker/src/numbers/)
-- buys the Twilio number, attaches it to the SIP trunk, creates the voice
-- channel and registers the number at xAI — the same steps the script ran.
--
-- Lifecycle (status):
--   requested    → provisioning   admin "Kostenpflichtig bestellen" (channel_name,
--                                 number_type, area_code, approved_by/at)
--   provisioning → active         worker finished all steps
--   provisioning → failed         worker step failed (provision_error), or the
--                                 worker restarted mid-run
--   failed       → provisioning   admin "Erneut versuchen": the worker RESUMES —
--                                 a number already bought (twilio_phone_number_sid)
--                                 or a channel already created (channel_id) is
--                                 reused, never bought/created twice
--   requested | failed (nothing bought yet) → deleted   admin "Anfrage ablehnen"
--
-- Worker claim: provision_started_at is set by an atomic conditional update
-- (status = 'provisioning' and provision_started_at is null). A row that is
-- 'provisioning' with provision_started_at set at worker boot was interrupted
-- and is moved to 'failed'.
--
-- RLS: unchanged. Members still only SELECT their org's rows, owners may only
-- INSERT/DELETE a 'requested' row (0016); every column added here and every
-- status transition is written exclusively by the service role (admin server
-- actions after requirePlatformAdmin, worker).

alter table public.phone_numbers drop constraint phone_numbers_status_check;
alter table public.phone_numbers
  add constraint phone_numbers_status_check
  check (status in ('requested', 'provisioning', 'failed', 'active', 'released'));

alter table public.phone_numbers
  -- voice channel name for the provisioned number (default "Telefon <Org>")
  add column channel_name text
    check (channel_name is null or char_length(channel_name) between 1 and 120),
  -- German area code WITHOUT the trunk zero (0511 → '511'); narrows the search
  add column area_code text
    check (area_code is null or area_code ~ '^[1-9][0-9]{1,4}$'),
  -- worker claim marker (null = waiting for the worker)
  add column provision_started_at timestamptz,
  add column provision_attempts integer not null default 0,
  -- last failure, German, shown to platform admins only (never secrets)
  add column provision_error text,
  add column approved_by uuid references auth.users (id) on delete set null,
  add column approved_at timestamptz;

-- worker poll: only rows waiting for / in provisioning are hot
create index phone_numbers_provisioning_idx on public.phone_numbers (approved_at)
  where status = 'provisioning';
