// Usage metering (migration 0021, billing foundation). Records measured infra
// costs that have no other home — live voice minutes and KB-index embeddings —
// into usage_events, attributed to the org. WhatsApp/e-mail/number-rental are
// NOT written here: they are computed at read time from message/channel counts ×
// the rate card (packages/core/src/billing.ts). Anthropic/OpenAI token costs
// already land in ai_runs.cost_usd.
//
// Best-effort by design: metering must NEVER break the pipeline. Every failure
// is swallowed (missing table pre-migration, dedup conflict on retry, transient
// DB error) — a lost cost row is acceptable; a failed customer reply is not.
// No message content is ever written (§7).
import type { Logger, SupabaseClient } from '@zendori/core';
import { toErrorInfo } from '../db.js';

export type UsageCategory =
  | 'voice_minutes'
  | 'index_embeddings'
  | 'whatsapp_message'
  | 'email'
  | 'sip_minutes'
  | 'other';

export type UsageProvider = 'xai' | 'twilio' | 'openai' | 'anthropic' | 'resend';

export interface RecordUsageParams {
  orgId: string;
  category: UsageCategory;
  provider: UsageProvider;
  /** Measured amount in `unit` (e.g. minutes, chunks, tokens). */
  quantity: number;
  unit: string;
  /** Our cost in USD (measured where the provider reports it, else quantity × rate). */
  costUsd: number;
  channelId?: string | null;
  conversationId?: string | null;
  /** Unique when set: prevents double-counting when a job retries (e.g. voice). */
  dedupKey?: string | null;
  /** Informational back-reference (voice_call_id / kb_source_id). */
  sourceRef?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordUsage(
  supabase: SupabaseClient,
  params: RecordUsageParams,
  logger?: Logger
): Promise<void> {
  try {
    const { error } = await supabase.from('usage_events').insert({
      org_id: params.orgId,
      channel_id: params.channelId ?? null,
      conversation_id: params.conversationId ?? null,
      category: params.category,
      provider: params.provider,
      quantity: params.quantity,
      unit: params.unit,
      cost_usd: params.costUsd,
      dedup_key: params.dedupKey ?? null,
      source_ref: params.sourceRef ?? null,
      metadata: params.metadata ?? {},
    });
    if (!error) return;
    const code = (error as { code?: string }).code;
    // 23505: dedup_key already present (retry) — the cost was recorded once.
    // 42P01/PGRST205: usage_events not migrated yet — stay silent.
    if (code === '23505' || code === '42P01' || code === 'PGRST205') return;
    logger?.warn({ err: toErrorInfo(error), category: params.category }, 'recordUsage failed');
  } catch (err) {
    logger?.warn({ err: toErrorInfo(err) }, 'recordUsage threw');
  }
}
