// Text side of data actions (Phase 13): what the draft step needs to let the
// model call the agent's actions — the tool definitions, the executor callback
// with the customer's identity bound from the conversation, and counters the
// decide step reads afterwards (a call waiting for confirmation must never be
// followed by an auto-sent reply). The call itself lives in actions/execute.ts.
import type { DraftTool, DraftToolCall } from '@zendori/ai';
import {
  buildActionToolSchema,
  createLogger,
  type AgentMode,
  type ChannelType,
  type DataActionContext,
  type SupabaseClient,
} from '@zendori/core';
import {
  loadAgentActions,
  needsConfirmation,
  runAgentAction,
  type ActionDeps,
  type LoadedAction,
} from '../actions/execute.js';
import { toErrorInfo } from '../db.js';

const logger = createLogger('draft-actions');

export interface DraftActionStats {
  /** Calls the model made (incl. refused ones). */
  calls: number;
  /** Calls recorded for a team member's confirmation — nothing was sent. */
  pendingApproval: number;
  /** Calls that reached the end system successfully. */
  succeeded: number;
  /** Calls that failed (validation, transport or an error status). */
  failed: number;
}

export interface DraftActionSession {
  tools: DraftTool[];
  runTool: (call: DraftToolCall) => Promise<unknown>;
  stats: DraftActionStats;
}

export interface PrepareDraftActionsArgs {
  orgId: string;
  agent: { id: string; mode: AgentMode };
  conversationId: string;
  messageId: string;
  channelType: ChannelType;
  /** Test seams, forwarded to the executor. */
  masterKey?: string | undefined;
  fetchImpl?: typeof fetch;
  assertUrl?: (url: string) => Promise<unknown>;
}

/** Tool definition of one action as the draft model sees it. */
export function toDraftTool(
  action: Pick<LoadedAction, 'name' | 'description' | 'kind' | 'parameters'>
): DraftTool {
  return {
    name: action.name,
    description:
      action.kind === 'write'
        ? `${action.description} (Schreibende Aktion im System des Unternehmens.)`
        : action.description,
    inputSchema: buildActionToolSchema(action.parameters),
  };
}

/**
 * The customer's identity for `context` parameters, read from the conversation
 * NOW — after the extraction step may have corrected the contact (form mails).
 */
async function loadActionContext(
  supabase: SupabaseClient,
  args: Pick<PrepareDraftActionsArgs, 'orgId' | 'conversationId' | 'channelType'>
): Promise<DataActionContext> {
  const context: DataActionContext = {
    'conversation.id': args.conversationId,
    'channel.type': args.channelType,
  };
  const { data: convRow, error: convError } = await supabase
    .from('conversations')
    .select('contact_id')
    .eq('org_id', args.orgId)
    .eq('id', args.conversationId)
    .maybeSingle();
  if (convError) throw convError;
  const contactId = (convRow as { contact_id: string | null } | null)?.contact_id;
  if (!contactId) return context;
  const { data: contactRow, error: contactError } = await supabase
    .from('contacts')
    .select('id, name, email, phone')
    .eq('org_id', args.orgId)
    .eq('id', contactId)
    .maybeSingle();
  if (contactError) throw contactError;
  const contact = contactRow as {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  if (!contact) return context;
  return {
    ...context,
    'contact.id': contact.id,
    'contact.name': contact.name || null,
    'contact.email': contact.email || null,
    'contact.phone': contact.phone || null,
  };
}

/**
 * Resolve the agent's data actions for one draft. Returns null when the agent
 * has none (or the pre-0035 schema has no tables) — the draft then runs exactly
 * as before. A load problem is logged and degrades to "no actions": the
 * customer still gets an answer from the knowledge base.
 */
export async function prepareDraftActions(
  supabase: SupabaseClient,
  args: PrepareDraftActionsArgs
): Promise<DraftActionSession | null> {
  // "Reine Annahme" never reaches the draft step; guard anyway.
  if (args.agent.mode === 'intake_only') return null;

  let actions: LoadedAction[];
  let context: DataActionContext;
  try {
    actions = await loadAgentActions(supabase, args.orgId, args.agent.id);
    if (actions.length === 0) return null;
    context = await loadActionContext(supabase, args);
  } catch (err) {
    logger.warn(
      { orgId: args.orgId, conversationId: args.conversationId, err: toErrorInfo(err) },
      'data actions could not be loaded — drafting without'
    );
    return null;
  }

  const deps: ActionDeps = {
    supabase,
    logger,
    masterKey: 'masterKey' in args ? args.masterKey : process.env.MASTER_ENCRYPTION_KEY,
    fetchImpl: args.fetchImpl,
    assertUrl: args.assertUrl,
  };
  const byName = new Map(actions.map((action) => [action.name, action]));
  const stats: DraftActionStats = { calls: 0, pendingApproval: 0, succeeded: 0, failed: 0 };

  const runTool = async (call: DraftToolCall): Promise<unknown> => {
    stats.calls += 1;
    const action = byName.get(call.name);
    if (!action) {
      stats.failed += 1;
      return { ok: false, error: 'unknown_tool' };
    }
    let result;
    try {
      result = await runAgentAction(deps, {
        action,
        modelArgs: call.input,
        context,
        conversationId: args.conversationId,
        messageId: args.messageId,
        agentId: args.agent.id,
        confirm: needsConfirmation(action, args.agent.mode),
      });
    } catch (err) {
      stats.failed += 1;
      logger.error(
        { conversationId: args.conversationId, actionId: action.id, err: toErrorInfo(err) },
        'draft data action failed'
      );
      return { ok: false, error: 'network' };
    }
    if (!result.ok) {
      stats.failed += 1;
      return result;
    }
    if (result.status === 'pending_approval') {
      stats.pendingApproval += 1;
      // the run id is internal — the model only needs to know nothing ran yet
      return { ok: true, status: 'pending_approval' };
    }
    stats.succeeded += 1;
    return { ok: true, data: result.data };
  };

  return { tools: actions.map(toDraftTool), runTool, stats };
}
