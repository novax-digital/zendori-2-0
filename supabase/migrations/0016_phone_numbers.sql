-- ============================================================================
-- Phone numbers: multi-tenant inventory + self-service requests (Phase 9)
--
-- One row per (requested or provisioned) Twilio voice number. Owners file a
-- REQUEST from the settings UI; the operator fulfills it with
-- scripts/provision-voice-number.ts --request <id> (buy at Twilio under the
-- Novax regulatory bundle, attach to the SIP trunk, register at xAI, create the
-- voice channel) — the script then flips the row to 'active'. The customer
-- redirects their public number to the provisioned one (Rufumleitungs-Modell,
-- §9). channels.config.phoneNumber stays the routing key; this table is the
-- inventory/registry on top.
-- ============================================================================

create table public.phone_numbers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  -- +E164 once provisioned; null while the request is open
  e164 text unique,
  number_type text not null default 'local'
    check (number_type in ('local', 'mobile', 'national')),
  status text not null default 'requested'
    check (status in ('requested', 'provisioning', 'active', 'released')),
  -- request wishes (free text): e.g. "Berlin (030)" / purpose note for the operator
  desired_region text,
  note text,
  -- provisioning bookkeeping (operator/script-written)
  twilio_phone_number_sid text,
  twilio_trunk_sid text,
  xai_phone_number_id text,
  channel_id uuid references public.channels (id) on delete set null,
  requested_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  activated_at timestamptz
);

create index phone_numbers_org_idx on public.phone_numbers (org_id);
create index phone_numbers_requested_idx on public.phone_numbers (created_at)
  where status = 'requested';

alter table public.phone_numbers enable row level security;

-- members see their org's numbers/requests (settings UI)
create policy phone_numbers_select on public.phone_numbers
  for select to authenticated using (private.is_org_member(org_id));

-- owners may file a REQUEST only: no number, no provider ids, status 'requested'
create policy phone_numbers_insert_request on public.phone_numbers
  for insert to authenticated
  with check (
    private.is_org_owner(org_id)
    and status = 'requested'
    and e164 is null
    and twilio_phone_number_sid is null
    and twilio_trunk_sid is null
    and xai_phone_number_id is null
    and channel_id is null
  );

-- owners may withdraw an OPEN request; provisioned numbers are operator-managed
create policy phone_numbers_delete_request on public.phone_numbers
  for delete to authenticated
  using (private.is_org_owner(org_id) and status = 'requested');

-- deliberately NO update policy: status transitions and provider ids are
-- written exclusively by the service role (provisioning script / admin)

-- --- backfill: inventory rows for numbers already living in voice channels ------

insert into public.phone_numbers
  (org_id, e164, number_type, status, twilio_phone_number_sid, twilio_trunk_sid,
   xai_phone_number_id, channel_id, activated_at)
select
  c.org_id,
  c.config->>'phoneNumber',
  'local',
  'active',
  nullif(c.config->>'twilioPhoneNumberSid', ''),
  nullif(c.config->>'twilioTrunkSid', ''),
  nullif(c.config->>'xaiPhoneNumberId', ''),
  c.id,
  c.created_at
from public.channels c
where c.type = 'voice'
  and coalesce(c.config->>'phoneNumber', '') <> ''
on conflict (e164) do nothing;
