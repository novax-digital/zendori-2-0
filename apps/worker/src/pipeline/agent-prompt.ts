// "Mit KI erstellen" in the agent editor (migration 0049): a member typed a few
// notes about an agent and asked for a suggested identity. The web app only
// stores the request (request_agent_prompt); this job writes the suggestion
// into the row, and the editor reads it from there.
//
//   queued → running → succeeded | failed
//
// One try per request — a failed one is simply asked for again by the member.
// The job never throws for a request it has claimed, so pg-boss never runs a
// paid call twice. Nothing here touches an agent: the suggestion only reaches
// `agents.identity` when the member takes it over and saves.
//
// Never logs the notes or the suggestion (§7).
import { AI_MODELS, suggestAgentIdentity } from '@zendori/ai';
import { isMissingRelationError, type Logger, type SupabaseClient } from '@zendori/core';
import { toErrorInfo } from '../db.js';

export const AGENT_PROMPT_QUEUE = 'agent.prompt';
/** Retries would repeat a paid call nobody may be waiting for any more. */
export const AGENT_PROMPT_RETRY_LIMIT = 0;
/** The editor waits about a minute; a request older than this is not worth a call. */
export const AGENT_PROMPT_MAX_AGE_MS = 10 * 60_000;
/** A request "running" for longer than this lost its worker. */
export const AGENT_PROMPT_STALE_MS = 5 * 60_000;
/** Requests hold what a member typed — kept for a week, then deleted. */
export const AGENT_PROMPT_KEEP_MS = 7 * 24 * 60 * 60_000;

export interface AgentPromptJob {
  requestId: string;
}

export interface AgentPromptDeps {
  supabase: SupabaseClient;
  logger: Logger;
  /** Injectable for tests. */
  suggest?: typeof suggestAgentIdentity;
  now?: () => number;
}

interface RequestRow {
  id: string;
  org_id: string;
  agent_kind: string;
  agent_name: string;
  notes: string;
  current_identity: string | null;
  created_at: string;
}

async function finish(
  supabase: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
  nowMs: number
): Promise<void> {
  // only a request this job still holds — the stale sweep may have closed it
  const { error } = await supabase
    .from('agent_prompt_requests')
    .update({ ...patch, finished_at: new Date(nowMs).toISOString() })
    .eq('id', id)
    .eq('state', 'running');
  if (error) throw error;
}

/** Writes the suggestion for one request. A no-op unless the request is still queued. */
export async function processAgentPrompt(deps: AgentPromptDeps, requestId: string): Promise<void> {
  const { supabase, logger } = deps;
  const now = deps.now ?? Date.now;

  // claim: queued → running, exactly once
  const { data, error } = await supabase
    .from('agent_prompt_requests')
    .update({ state: 'running', started_at: new Date(now()).toISOString() })
    .eq('id', requestId)
    .eq('state', 'queued')
    .select('id, org_id, agent_kind, agent_name, notes, current_identity, created_at');
  if (error) {
    if (isMissingRelationError(error)) return;
    throw error;
  }
  const row = ((data ?? []) as RequestRow[])[0];
  if (!row) return;

  try {
    if (now() - Date.parse(row.created_at) > AGENT_PROMPT_MAX_AGE_MS) {
      await finish(supabase, row.id, { state: 'failed', error_code: 'expired' }, now());
      return;
    }

    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', row.org_id)
      .maybeSingle();
    if (orgError) throw orgError;
    const companyName = (org as { name: string } | null)?.name?.trim() || 'dem Unternehmen';

    const startedAt = now();
    const suggestion = await (deps.suggest ?? suggestAgentIdentity)({
      companyName,
      agentKind: row.agent_kind === 'voice' ? 'voice' : 'text',
      agentName: row.agent_name,
      notes: row.notes,
      currentIdentity: row.current_identity,
    });
    await finish(
      supabase,
      row.id,
      {
        state: 'succeeded',
        result: suggestion.result,
        error_code: null,
        model: AI_MODELS.draft,
        cost_usd: suggestion.costUsd,
        latency_ms: now() - startedAt,
      },
      now()
    );
    logger.info({ requestId: row.id }, 'agent identity suggested');
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    const code = message.includes('ANTHROPIC_API_KEY')
      ? 'not_configured'
      : message.includes('war leer')
        ? 'empty_result'
        : 'ai_failed';
    logger.warn({ requestId: row.id, code, err: toErrorInfo(err) }, 'agent identity failed');
    try {
      await finish(supabase, row.id, { state: 'failed', error_code: code }, now());
    } catch (writeError) {
      // the stale sweep closes the request
      logger.error({ requestId: row.id, err: toErrorInfo(writeError) }, 'agent identity not closed');
    }
  }
}

/** Closes requests whose worker died mid-call, so the editor stops waiting. */
export async function failStaleAgentPrompts(
  supabase: SupabaseClient,
  nowMs: number = Date.now()
): Promise<void> {
  const { error } = await supabase
    .from('agent_prompt_requests')
    .update({ state: 'failed', error_code: 'stale', finished_at: new Date(nowMs).toISOString() })
    .eq('state', 'running')
    .lt('started_at', new Date(nowMs - AGENT_PROMPT_STALE_MS).toISOString());
  if (error && !isMissingRelationError(error)) throw error;
}

/** Deletes requests older than a week. */
export async function pruneAgentPrompts(
  supabase: SupabaseClient,
  nowMs: number = Date.now()
): Promise<void> {
  const { error } = await supabase
    .from('agent_prompt_requests')
    .delete()
    .lt('created_at', new Date(nowMs - AGENT_PROMPT_KEEP_MS).toISOString());
  if (error && !isMissingRelationError(error)) throw error;
}
