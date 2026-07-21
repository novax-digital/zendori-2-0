-- ============================================================================
-- Per-agent human handoff (owner decision 2026-07-21)
--
-- agents.handoff_enabled: the per-agent master switch. OFF suppresses ONLY the
-- low_confidence trigger — an explicit customer wish (user_request) and org
-- escalation keywords ALWAYS hand off (a bot refusing "ich möchte einen
-- Menschen" is the worst loss path; keywords are org policy governed by the
-- list in /settings/ai). Manual takeover and intake are untouched.
--
-- handoff_events.outcome: server-decided, persisted outcome per event so
-- handoffs are observable/tunable (§6-Funnel): pending_human (waiting in the
-- inbox), transferred (voice REFER succeeded), transfer_failed (REFER API
-- failed → callback flow), callback_ticket (no transfer attempted — outside
-- hours / no number / no live transfer), suppressed (toggle off swallowed a
-- low_confidence trigger — countable, never invisible). NO backfill: historic
-- rows keep outcome NULL (labeling them would corrupt the funnel).
--
-- handoff_events.details: content-free context (flags, error codes) — never
-- message content (§7).
--
-- org_settings.handoff_sla_minutes: v1.5 reminder — a pending handoff without
-- an agent reaction for longer than this (evaluated only WITHIN business
-- hours) gets an internal note. NULL = reminder off.
-- ============================================================================

alter table public.agents add column handoff_enabled boolean not null default true;

alter table public.handoff_events add column outcome text
  check (outcome in ('pending_human', 'transferred', 'transfer_failed', 'callback_ticket', 'suppressed'));
alter table public.handoff_events add column details jsonb not null default '{}'::jsonb;

alter table public.org_settings add column handoff_sla_minutes integer
  check (handoff_sla_minutes is null or (handoff_sla_minutes between 5 and 1440));
