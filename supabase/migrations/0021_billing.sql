-- Zendori v2 — 0021: usage metering + billing settings
--
-- Foundation for the customer/admin billing area. Every cost-causing action is
-- attributable to an org. Two homes for cost data:
--   1. ai_runs.cost_usd            — already captures all Anthropic + OpenAI
--                                    (embeddings/whisper) token costs per step.
--   2. usage_events (this table)   — the ledger for measured infra costs that had
--                                    no home before: live voice minutes (xAI +
--                                    Twilio SIP) and knowledge-base index
--                                    embeddings. WhatsApp/e-mail/number-rental are
--                                    NOT stored per event — they are computed at
--                                    read time from message/channel counts × the
--                                    rate card (packages/core/src/billing.ts).
--
-- Both tables are read exclusively through the service role in guarded server
-- code (admin: platform_admins; customer: verified org membership). The billing
-- rollup returns only €-amounts + usage quantities to the client — our raw USD
-- cost and the markup factor never leave the server (margin stays hidden).

-- ============================================================================
-- usage_events — append-only cost ledger for measured infra costs
-- ============================================================================

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  -- soft references: a deleted channel/conversation must not erase the cost row
  channel_id uuid references public.channels (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  -- broad enough set that adding actual WhatsApp/SIP metering later needs no migration
  category text not null check (category in (
    'voice_minutes', 'index_embeddings', 'whatsapp_message', 'email', 'sip_minutes', 'other'
  )),
  provider text not null check (provider in ('xai', 'twilio', 'openai', 'anthropic', 'resend')),
  -- measured amount in `unit` (e.g. 3.5 minutes, 1840 tokens)
  quantity numeric not null default 0,
  unit text not null,
  -- our cost in USD (measured where the provider reports it, else quantity × rate card)
  cost_usd numeric not null default 0,
  -- unique when set — guards against double-counting on retries (voice: one row
  -- per call). Left null for events that may legitimately repeat (re-index).
  dedup_key text,
  -- informational back-reference (voice_call_id / kb_source_id); not a FK
  source_ref text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index usage_events_dedup_idx
  on public.usage_events (dedup_key) where dedup_key is not null;
create index usage_events_org_time_idx on public.usage_events (org_id, occurred_at desc);
create index usage_events_org_cat_idx on public.usage_events (org_id, category);

-- Service-role only: no authenticated/member policies. Billing pages read via
-- the service role after an explicit membership/admin check, so cost_usd is
-- never exposed through the anon API.
alter table public.usage_events enable row level security;

-- ============================================================================
-- billing_settings — markup + FX for turning our USD cost into a customer €
-- ============================================================================
--
-- One global default row (org_id null) plus optional per-org overrides. Interim
-- pricing until a full plan/tier model exists: price_eur = cost_usd × usd_to_eur
-- × markup_factor. markup_factor is sensitive (reveals margin) → service-role only.

create table public.billing_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations (id) on delete cascade,
  markup_factor numeric not null default 1.0 check (markup_factor >= 0),
  usd_to_eur numeric not null default 0.92 check (usd_to_eur > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

-- at most one row per org, and at most one global (null-org) row
create unique index billing_settings_org_idx
  on public.billing_settings (org_id) where org_id is not null;
create unique index billing_settings_global_idx
  on public.billing_settings ((true)) where org_id is null;

-- seed the global default
insert into public.billing_settings (org_id) values (null);

alter table public.billing_settings enable row level security;

-- Supports the per-org message counts in billing_org_rollup (WhatsApp/e-mail).
create index if not exists messages_org_time_idx on public.messages (org_id, created_at);

-- ============================================================================
-- billing_org_rollup — server-side usage aggregation for one org + period
-- ============================================================================
--
-- Returns one row per category with the raw measured quantity and our USD cost.
-- Measured costs (ai_runs token cost, usage_events voice/index) are summed here;
-- count-priced categories (whatsapp/email/numbers) return the quantity only and
-- the rate card in packages/core/src/billing.ts applies the price in TS. Runs as
-- the service role from guarded server code (admin or verified membership); never
-- exposed to authenticated members (execute revoked below). SQL-side aggregation
-- avoids PostgREST's 1000-row read cap.

create or replace function public.billing_org_rollup(
  p_org_id uuid,
  p_from timestamptz,
  p_to timestamptz
) returns table (category text, quantity numeric, cost_usd numeric)
language sql
stable
security invoker
set search_path = public
as $$
  -- Anthropic text steps (classify/extract/draft/rerank/learn)
  select 'ai'::text, count(*)::numeric, coalesce(sum(ar.cost_usd), 0)::numeric
    from ai_runs ar
    where ar.org_id = p_org_id and ar.created_at >= p_from and ar.created_at < p_to
      and ar.step in ('classify', 'extract', 'draft', 'rerank', 'learn')
  union all
  -- Embeddings: retrieval runs (ai_runs) + KB-index events (usage_events)
  select 'embeddings',
    (select count(*) from ai_runs where org_id = p_org_id and created_at >= p_from
       and created_at < p_to and step = 'retrieve')
      + (select count(*) from usage_events where org_id = p_org_id and occurred_at >= p_from
           and occurred_at < p_to and category = 'index_embeddings'),
    (select coalesce(sum(cost_usd), 0) from ai_runs where org_id = p_org_id and created_at >= p_from
       and created_at < p_to and step = 'retrieve')
      + (select coalesce(sum(cost_usd), 0) from usage_events where org_id = p_org_id
           and occurred_at >= p_from and occurred_at < p_to and category = 'index_embeddings')
  union all
  -- Whisper voice-note transcription
  select 'transcription', count(*)::numeric, coalesce(sum(ar.cost_usd), 0)::numeric
    from ai_runs ar
    where ar.org_id = p_org_id and ar.created_at >= p_from and ar.created_at < p_to
      and ar.step = 'transcribe'
  union all
  -- Live phone minutes (measured cost written by the worker)
  select 'voice', coalesce(sum(ue.quantity), 0)::numeric, coalesce(sum(ue.cost_usd), 0)::numeric
    from usage_events ue
    where ue.org_id = p_org_id and ue.occurred_at >= p_from and ue.occurred_at < p_to
      and ue.category = 'voice_minutes'
  union all
  -- Count-priced: outbound WhatsApp messages (rate applied in TS)
  select 'whatsapp_count',
    (select count(*) from messages m join channels c on c.id = m.channel_id
       where m.org_id = p_org_id and m.created_at >= p_from and m.created_at < p_to
         and c.type = 'whatsapp' and m.direction = 'out')::numeric,
    0::numeric
  union all
  -- Count-priced: outbound e-mails (Resend send)
  select 'email_count',
    (select count(*) from messages m join channels c on c.id = m.channel_id
       where m.org_id = p_org_id and m.created_at >= p_from and m.created_at < p_to
         and c.type = 'email' and m.direction = 'out')::numeric,
    0::numeric
  union all
  -- Count-priced: currently active rented numbers (snapshot, prorated in TS)
  select 'numbers_count',
    (select count(*) from channels
       where org_id = p_org_id and is_active and type in ('voice', 'whatsapp'))::numeric,
    0::numeric
$$;

-- Billing is computed only in guarded service-role server code — never let an
-- anonymous or authenticated caller invoke the rollup directly (Supabase grants
-- EXECUTE on new public functions to anon/authenticated by default, so revoke
-- both explicitly on top of the PUBLIC revoke).
revoke all on function public.billing_org_rollup(uuid, timestamptz, timestamptz) from public;
revoke all on function public.billing_org_rollup(uuid, timestamptz, timestamptz) from anon;
revoke all on function public.billing_org_rollup(uuid, timestamptz, timestamptz) from authenticated;
grant execute on function public.billing_org_rollup(uuid, timestamptz, timestamptz) to service_role;
