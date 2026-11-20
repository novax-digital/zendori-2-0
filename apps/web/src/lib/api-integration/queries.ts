import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';

// Phase 13 — data-action runs of one conversation, for the inbox. RLS scopes
// the rows to the member's org; the caller has already checked channel access
// for the conversation (getConversationDetail).

export interface ConversationActionRun {
  id: string;
  state: string;
  trigger: string;
  /** Values sent (or to be sent) to the end system. */
  args: Record<string, unknown>;
  /** Allowlisted response fields of a finished run. */
  result: unknown;
  httpStatus: number | null;
  errorCode: string | null;
  createdAt: string;
  action: { label: string; kind: 'read' | 'write' } | null;
}

const RUN_LIMIT = 8;

/**
 * Runs waiting for a decision (always) plus the most recent finished ones.
 * Returns [] before migration 0035 or on any load problem — the inbox must
 * never fail because of this extra block.
 */
export async function listConversationActionRuns(
  orgId: string,
  conversationId: string
): Promise<ConversationActionRun[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('action_runs')
    .select('id, data_action_id, state, trigger, args, result, http_status, error_code, created_at')
    .eq('org_id', orgId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error || !data || data.length === 0) return [];

  const rows = data as {
    id: string;
    data_action_id: string;
    state: string;
    trigger: string;
    args: unknown;
    result: unknown;
    http_status: number | null;
    error_code: string | null;
    created_at: string;
  }[];
  const pending = rows.filter((row) => row.state === 'pending_approval');
  const others = rows.filter((row) => row.state !== 'pending_approval');
  const shown = [...pending, ...others.slice(0, Math.max(0, RUN_LIMIT - pending.length))];

  const { data: actionData } = await supabase
    .from('data_actions')
    .select('id, label, kind')
    .eq('org_id', orgId)
    .in('id', [...new Set(shown.map((row) => row.data_action_id))]);
  const actions = new Map(
    ((actionData ?? []) as { id: string; label: string; kind: 'read' | 'write' }[]).map((a) => [
      a.id,
      { label: a.label, kind: a.kind },
    ])
  );

  return shown.map((row) => ({
    id: row.id,
    state: row.state,
    trigger: row.trigger,
    args:
      row.args !== null && typeof row.args === 'object' && !Array.isArray(row.args)
        ? (row.args as Record<string, unknown>)
        : {},
    result: row.result,
    httpStatus: row.http_status,
    errorCode: row.error_code,
    createdAt: row.created_at,
    action: actions.get(row.data_action_id) ?? null,
  }));
}
