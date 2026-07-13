-- Phase 7a: the Twilio WhatsApp sender number is a GLOBAL routing key — inbound
-- webhooks are matched by config->>'sender' across all orgs (like the email
-- intake address in 0001, channels_email_inbound_address_idx). Without a
-- uniqueness guard the same +E164 could be connected in two orgs, making inbound
-- routing nondeterministic (Postgres LIMIT 1 has no order guarantee) and risking
-- cross-tenant misdelivery. This partial unique index mirrors the email one.

create unique index if not exists channels_whatsapp_twilio_sender_idx
  on public.channels ((config ->> 'sender'))
  where type = 'whatsapp' and config ->> 'provider' = 'twilio';
