-- Conversation status 'hubspot_sent' — "An HubSpot gesendet".
--
-- Once a conversation is synced to HubSpot (manual button or automatic rules),
-- the ticket is worked THERE: leaving the conversation on 'pending' would keep
-- it in the §6 waiting queue although nobody in Zendori is expected to act.
-- The worker sets this status after every successful sync (hubspot-sync.ts,
-- never overwriting 'resolved'); the inbox shows the status filter/picker only
-- while an active HubSpot integration exists.
--
-- Same inline-check-rename pattern as 0020 (ai_runs_step_check).
alter table public.conversations drop constraint conversations_status_check;
alter table public.conversations add constraint conversations_status_check
  check (status in ('open', 'pending', 'resolved', 'hubspot_sent'));
