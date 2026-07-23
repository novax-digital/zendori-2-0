// Learning-loop distillation (migration 0020, CLAUDE.md-Konzept "Gelernte
// Antworten"): a candidate row marks a human reply worth learning from
// (handoff resolution or a materially edited draft). This job distills the
// exchange into a generalized, PII-free Q&A pair via Haiku and flips the row
// to 'proposed' for human review — or 'auto_rejected' when there is nothing
// reusable. Message content is never logged (§7); ai_runs summaries are
// content-free by construction.
import { AI_MODELS, learn } from '@zendori/ai';
import type { SupabaseClient } from '@zendori/core';
import { getServiceClient } from '../db.js';

export const LEARN_DISTILL_QUEUE = 'learned.distill';
export const LEARN_DISTILL_RETRY_LIMIT = 2;

export interface LearnDistillJob {
  learnedAnswerId: string;
}

/** Prior inbound turns joined into the "customer request" (covers bursts). */
const REQUEST_CONTEXT_TURNS = 3;

interface CandidateRow {
  id: string;
  org_id: string;
  conversation_id: string | null;
  /** Null after the origin message was deleted (composite FK SET NULL, 0020). */
  message_id: string | null;
  origin: string;
  status: string;
}

/**
 * Distill one learning candidate. Idempotent: only rows still in 'candidate'
 * are processed, and every terminal write is guarded on that status so a
 * concurrent duplicate can never overwrite a review decision. Throws on
 * transient failures so pg-boss retries; the queue handler marks the row
 * 'error' once retries are exhausted.
 */
export async function distillLearnedAnswer(learnedAnswerId: string): Promise<void> {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from('learned_answers')
    .select('id, org_id, conversation_id, message_id, origin, status')
    .eq('id', learnedAnswerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return; // row deleted — nothing to do
  const row = data as unknown as CandidateRow;
  if (row.status !== 'candidate') return; // already distilled/decided
  if (!row.message_id) {
    // origin message deleted before distillation — nothing left to learn from
    await autoReject(supabase, row.id);
    return;
  }

  // The human answer that triggered the candidate.
  const { data: msgData, error: msgError } = await supabase
    .from('messages')
    .select('id, conversation_id, content, created_at')
    .eq('id', row.message_id)
    .maybeSingle();
  if (msgError) throw msgError;
  const answerMessage = msgData as unknown as {
    id: string;
    conversation_id: string;
    content: string | null;
    created_at: string;
  } | null;
  const humanAnswer = answerMessage?.content?.trim() ?? '';
  if (!answerMessage || humanAnswer.length === 0) {
    await autoReject(supabase, row.id);
    return;
  }

  // The customer request: the last inbound contact turns before the reply.
  const { data: inboundData, error: inboundError } = await supabase
    .from('messages')
    .select('content')
    .eq('conversation_id', answerMessage.conversation_id)
    .eq('direction', 'in')
    .eq('sender_type', 'contact')
    .lt('created_at', answerMessage.created_at)
    .order('created_at', { ascending: false })
    .limit(REQUEST_CONTEXT_TURNS);
  if (inboundError) throw inboundError;
  const customerRequest = ((inboundData ?? []) as { content: string | null }[])
    .reverse()
    .map((turn) => (turn.content ?? '').trim())
    .filter((content) => content.length > 0)
    .join('\n')
    .trim();
  if (customerRequest.length === 0) {
    await autoReject(supabase, row.id);
    return;
  }

  const orgName = await loadOrgName(supabase, row.org_id);

  const started = Date.now();
  const { result, costUsd } = await learn({
    companyName: orgName,
    customerRequest,
    humanAnswer,
  });
  const latencyMs = Date.now() - started;

  const question = result.question.trim();
  const answer = result.answer.trim();
  const proposed = result.worth_learning && question.length > 0 && answer.length > 0;

  const { error: updateError } = await supabase
    .from('learned_answers')
    .update(
      proposed ? { status: 'proposed', question, answer } : { status: 'auto_rejected' }
    )
    .eq('id', row.id)
    .eq('status', 'candidate');
  if (updateError) throw updateError;

  // Cost/latency observability — summaries are content-free (§7).
  await supabase.from('ai_runs').insert({
    org_id: row.org_id,
    conversation_id: row.conversation_id,
    step: 'learn',
    model: AI_MODELS.classify,
    input_summary: `origin=${row.origin} request_chars=${customerRequest.length} answer_chars=${humanAnswer.length}`,
    output_summary: proposed ? 'proposed' : 'auto_rejected',
    latency_ms: latencyMs,
    cost_usd: costUsd,
  });
}

/**
 * Terminal-failure handler (retries exhausted): mark the candidate 'error' so
 * the scan stops re-enqueuing it; the row stays visible for a later retry via
 * the DB. Never throws.
 */
export async function markLearnDistillFailed(learnedAnswerId: string): Promise<void> {
  const supabase = getServiceClient();
  try {
    await supabase
      .from('learned_answers')
      .update({ status: 'error' })
      .eq('id', learnedAnswerId)
      .eq('status', 'candidate');
  } catch {
    // Best-effort: never throw from the failure handler.
  }
}

async function autoReject(supabase: SupabaseClient, rowId: string): Promise<void> {
  const { error } = await supabase
    .from('learned_answers')
    .update({ status: 'auto_rejected' })
    .eq('id', rowId)
    .eq('status', 'candidate');
  if (error) throw error;
}

async function loadOrgName(supabase: SupabaseClient, orgId: string): Promise<string> {
  const { data, error } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .maybeSingle();
  if (error) throw error;
  const name = (data as { name?: string } | null)?.name;
  return name && name.trim().length > 0 ? name : 'unser Unternehmen';
}
