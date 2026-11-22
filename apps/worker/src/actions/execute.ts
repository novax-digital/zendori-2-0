// Phase 13 — data actions: the ONE place that calls an org's own end system.
// Used by the voice tools, the text pipeline's tool loop and the queued-run job
// (test runs + runs a team member approved in the inbox). Everything runs in the
// worker so the end system sees a single egress IP (§12) and the web app never
// does anything long-running.
//
// Tenant isolation: org_id comes from server truth (the agent / the run row),
// never from the model. Identity values are bound here from the conversation's
// contact (resolveActionValues), so the model cannot ask for somebody else's
// data. Never logs argument or response content (§7).
import { z } from 'zod';
import {
  ACTION_RESULT_MAX_CHARS,
  apiConnectionConfigSchema,
  buildActionRequest,
  capActionResult,
  coerceActionValues,
  dataActionKindSchema,
  dataActionMethodSchema,
  dataActionParametersSchema,
  dataActionResponseFieldsSchema,
  decryptSecret,
  isMissingColumnError,
  isMissingRelationError,
  mapActionResponse,
  resolveActionValues,
  type ActionRunErrorCode,
  type ActionValues,
  type ApiConnectionConfig,
  type DataActionContext,
  type DataActionKind,
  type DataActionMethod,
  type DataActionParameter,
  type Logger,
  type SupabaseClient,
} from '@zendori/core';
import { CustomApiError, callCustomApi, type CustomApiAuth } from '@zendori/integrations';
import { assertPublicUrl } from '../pipeline/index-source.js';
import { toErrorInfo } from '../db.js';
import { performMcpCall } from './mcp-call.js';

/** Hard cap on runs an org may start per minute (cost + abuse brake). */
export const ACTION_RUNS_PER_MINUTE = 60;
/** A run still 'running' after this long belongs to a dead worker process. */
export const ACTION_RUN_STALE_MS = 2 * 60 * 1000;
const ERROR_RESULT_MAX_CHARS = 600;

export interface LoadedAction {
  id: string;
  orgId: string;
  connectionId: string;
  name: string;
  label: string;
  description: string;
  kind: DataActionKind;
  method: DataActionMethod;
  path: string;
  parameters: DataActionParameter[];
  responseFields: string[];
  requiresConfirmation: boolean;
  timeoutMs: number;
  /**
   * Phase 14a: set = the action is a tools/call of this tool on an MCP server
   * (method/path are then unused); null = an HTTP call.
   */
  mcpToolName: string | null;
}

export interface ActionDeps {
  supabase: SupabaseClient;
  logger: Logger;
  /** MASTER_ENCRYPTION_KEY; undefined = connections with credentials cannot run. */
  masterKey: string | undefined;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  assertUrl?: (url: string) => Promise<unknown>;
}

const actionRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  connection_id: z.string(),
  name: z.string(),
  label: z.string(),
  description: z.string(),
  kind: dataActionKindSchema,
  method: dataActionMethodSchema,
  path: z.string(),
  parameters: dataActionParametersSchema,
  response_fields: dataActionResponseFieldsSchema,
  requires_confirmation: z.boolean(),
  timeout_ms: z.number(),
  // absent before migration 0039
  mcp_tool_name: z.string().nullish(),
});

const ACTION_COLUMNS_0035 =
  'id, org_id, connection_id, name, label, description, kind, method, path, parameters, response_fields, requires_confirmation, timeout_ms';
const ACTION_COLUMNS = `${ACTION_COLUMNS_0035}, mcp_tool_name`;

/**
 * Run an action query with the current column list; before migration 0039
 * (mcp_tool_name missing) run it again with the 0035 columns. Without this a
 * worker deployed ahead of the migration would lose ALL data actions.
 */
async function withActionColumns<T extends { error: unknown }>(
  run: (columns: string) => PromiseLike<T>
): Promise<T> {
  const result = await run(ACTION_COLUMNS);
  if (result.error && isMissingColumnError(result.error)) return run(ACTION_COLUMNS_0035);
  return result;
}

function toLoadedAction(row: unknown): LoadedAction | null {
  const parsed = actionRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const a = parsed.data;
  return {
    id: a.id,
    orgId: a.org_id,
    connectionId: a.connection_id,
    name: a.name,
    label: a.label,
    description: a.description,
    kind: a.kind,
    method: a.method,
    path: a.path,
    parameters: a.parameters,
    responseFields: a.response_fields,
    requiresConfirmation: a.requires_confirmation,
    timeoutMs: a.timeout_ms,
    mcpToolName: a.mcp_tool_name ?? null,
  };
}

/**
 * Active actions linked to an agent whose connection is active too. Empty
 * before migration 0035 (missing tables) and on any load problem — an agent
 * without actions simply behaves as before.
 */
export async function loadAgentActions(
  supabase: SupabaseClient,
  orgId: string,
  agentId: string
): Promise<LoadedAction[]> {
  const { data: links, error: linkError } = await supabase
    .from('agent_data_actions')
    .select('data_action_id')
    .eq('org_id', orgId)
    .eq('agent_id', agentId);
  if (linkError) {
    if (isMissingRelationError(linkError)) return [];
    throw linkError;
  }
  const ids = ((links ?? []) as { data_action_id: string }[]).map((l) => l.data_action_id);
  if (ids.length === 0) return [];

  const { data: rows, error } = await withActionColumns((columns) =>
    supabase
      .from('data_actions')
      .select(columns)
      .eq('org_id', orgId)
      .eq('is_active', true)
      .in('id', ids)
      .order('created_at', { ascending: true })
  );
  if (error) throw error;
  const actions = ((rows ?? []) as unknown[])
    .map(toLoadedAction)
    .filter((a): a is LoadedAction => a !== null);
  if (actions.length === 0) return [];

  const { data: connections, error: connError } = await supabase
    .from('api_connections')
    .select('id')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .in('id', [...new Set(actions.map((a) => a.connectionId))]);
  if (connError) throw connError;
  const active = new Set(((connections ?? []) as { id: string }[]).map((c) => c.id));
  return actions.filter((a) => active.has(a.connectionId));
}

async function loadActionById(
  supabase: SupabaseClient,
  orgId: string,
  actionId: string
): Promise<{ action: LoadedAction | null; isActive: boolean }> {
  const { data, error } = await withActionColumns((columns) =>
    supabase
      .from('data_actions')
      .select(`${columns}, is_active`)
      .eq('org_id', orgId)
      .eq('id', actionId)
      .maybeSingle()
  );
  if (error) throw error;
  if (!data) return { action: null, isActive: false };
  return {
    action: toLoadedAction(data),
    isActive: (data as unknown as { is_active?: boolean }).is_active === true,
  };
}

// --- the call --------------------------------------------------------------------

export type ActionOutcome =
  | { ok: true; httpStatus: number; latencyMs: number; result: unknown }
  | {
      ok: false;
      errorCode: ActionRunErrorCode;
      httpStatus: number | null;
      latencyMs: number | null;
      /** Bounded excerpt of the end system's error body (http_error only). */
      result: unknown;
    };

function failure(errorCode: ActionRunErrorCode): ActionOutcome {
  return { ok: false, errorCode, httpStatus: null, latencyMs: null, result: null };
}

/**
 * Decrypt a connection's credentials for one request. Null = they cannot be
 * used (master key missing, or ciphertext that does not decrypt). Shared with
 * the event dispatcher (events.ts).
 */
export async function decryptConnectionSecrets(
  config: ApiConnectionConfig,
  masterKey: string | undefined
): Promise<{ auth: CustomApiAuth; signingSecret: string | null } | null> {
  const needsKey = config.auth.kind !== 'none' || Boolean(config.signing_secret_encrypted);
  if (needsKey && !masterKey) return null;
  try {
    const signingSecret = config.signing_secret_encrypted
      ? await decryptSecret(config.signing_secret_encrypted, masterKey as string)
      : null;
    switch (config.auth.kind) {
      case 'none':
        return { auth: { kind: 'none' }, signingSecret };
      case 'bearer':
        return {
          auth: {
            kind: 'bearer',
            secret: await decryptSecret(config.auth.secret_encrypted, masterKey as string),
          },
          signingSecret,
        };
      case 'header':
        return {
          auth: {
            kind: 'header',
            headerName: config.auth.header_name,
            secret: await decryptSecret(config.auth.secret_encrypted, masterKey as string),
          },
          signingSecret,
        };
      case 'basic':
        return {
          auth: {
            kind: 'basic',
            username: config.auth.username,
            secret: await decryptSecret(config.auth.secret_encrypted, masterKey as string),
          },
          signingSecret,
        };
    }
  } catch {
    return null;
  }
}

/**
 * Perform the HTTP call of one run with already-validated values. `runId` is
 * the Idempotency-Key, so the end system can dedupe a delivery it sees twice.
 */
export async function performActionCall(
  deps: ActionDeps,
  action: LoadedAction,
  values: ActionValues,
  runId: string
): Promise<ActionOutcome> {
  const { data: connRow, error } = await deps.supabase
    .from('api_connections')
    .select('base_url, config, is_active')
    .eq('org_id', action.orgId)
    .eq('id', action.connectionId)
    .maybeSingle();
  if (error) throw error;
  const connection = connRow as { base_url: string; config: unknown; is_active: boolean } | null;
  if (!connection || !connection.is_active) return failure('connection_inactive');

  const config = apiConnectionConfigSchema.safeParse(connection.config ?? {});
  if (!config.success) return failure('config_invalid');
  const secrets = await decryptConnectionSecrets(config.data, deps.masterKey);
  if (!secrets) return failure('config_invalid');

  // Phase 14a: an imported MCP tool — same run, a tools/call instead of an HTTP
  // request. base_url is the server's endpoint; requests are not signed (the
  // signature scheme belongs to the HTTP contract of Phase 13).
  const mcpToolName = action.mcpToolName;
  if (mcpToolName !== null) {
    return performMcpCall(
      deps,
      { ...action, mcpToolName },
      connection.base_url,
      secrets.auth,
      values,
      runId
    );
  }

  let request;
  try {
    request = buildActionRequest(action, connection.base_url, values);
  } catch {
    return failure('invalid_args');
  }

  try {
    const response = await callCustomApi({
      url: request.url,
      method: request.method,
      body: request.body,
      auth: secrets.auth,
      signingSecret: secrets.signingSecret,
      requestId: runId,
      timeoutMs: action.timeoutMs,
      fetchImpl: deps.fetchImpl,
      assertUrl: deps.assertUrl ?? assertPublicUrl,
    });
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        errorCode: 'http_error',
        httpStatus: response.status,
        latencyMs: response.latencyMs,
        result: capActionResult(
          response.json !== undefined ? response.json : response.text.slice(0, 300),
          ERROR_RESULT_MAX_CHARS
        ),
      };
    }
    const mapped =
      response.json !== undefined
        ? mapActionResponse(response.json, action.responseFields)
        : response.text.length > 0
          ? { text: response.text }
          : null;
    return {
      ok: true,
      httpStatus: response.status,
      latencyMs: response.latencyMs,
      result: capActionResult(mapped, ACTION_RESULT_MAX_CHARS),
    };
  } catch (err) {
    if (err instanceof CustomApiError) return failure(err.code);
    throw err;
  }
}

// --- run bookkeeping -------------------------------------------------------------

async function finishRun(
  supabase: SupabaseClient,
  runId: string,
  outcome: ActionOutcome
): Promise<void> {
  const { error } = await supabase
    .from('action_runs')
    .update({
      state: outcome.ok ? 'succeeded' : 'failed',
      result: outcome.result ?? null,
      http_status: outcome.httpStatus,
      latency_ms: outcome.latencyMs,
      error_code: outcome.ok ? null : outcome.errorCode,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);
  if (error) throw error;
}

async function isRateLimited(supabase: SupabaseClient, orgId: string): Promise<boolean> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await supabase
    .from('action_runs')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .gte('created_at', since);
  // A failing count must not take the agent's tools down — the per-call loop
  // bounds in the callers still apply.
  if (error) return false;
  return (count ?? 0) >= ACTION_RUNS_PER_MINUTE;
}

/** Key order must not make two equal value sets look different. */
function stableValues(values: unknown): string {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) return 'null';
  const record = values as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]])
  );
}

/**
 * An earlier run of this action for the same inbound message with identical
 * values that already reached the end system (succeeded), is waiting for a
 * human (pending_approval / queued), or was interrupted mid-call (running).
 * Failed runs are NOT reused — a retry may legitimately try again.
 *
 * An interrupted run has an UNKNOWN outcome: the end system may or may not have
 * received it. It is never sent again (a write could happen twice) and it is
 * not presented as done or as waiting — the model is told it failed, which
 * routes the request to a human via the normal low-confidence path.
 */
async function findPriorRun(
  supabase: SupabaseClient,
  action: LoadedAction,
  messageId: string,
  values: ActionValues
): Promise<ActionToolResult | null> {
  const { data, error } = await supabase
    .from('action_runs')
    .select('id, state, args, result')
    .eq('org_id', action.orgId)
    .eq('message_id', messageId)
    .eq('data_action_id', action.id)
    .in('state', ['succeeded', 'pending_approval', 'queued', 'running'])
    .order('created_at', { ascending: true });
  if (error) throw error;
  const wanted = stableValues(values);
  const match = (
    (data ?? []) as { id: string; state: string; args: unknown; result: unknown }[]
  ).find((run) => stableValues(run.args) === wanted);
  if (!match) return null;
  if (match.state === 'succeeded') return { ok: true, status: 'done', data: match.result ?? null };
  if (match.state === 'running') return { ok: false, error: 'timeout' };
  return { ok: true, status: 'pending_approval', run_id: match.id };
}

export interface AgentActionCall {
  action: LoadedAction;
  /** Raw tool arguments from the model — untrusted. */
  modelArgs: unknown;
  context: DataActionContext;
  conversationId: string;
  messageId: string | null;
  agentId: string | null;
  /**
   * True when a team member has to confirm this call in the inbox first
   * (see needsConfirmation). The run is then only recorded.
   */
  confirm: boolean;
}

/** What the model gets back as the tool result (JSON-serializable, no secrets). */
export type ActionToolResult =
  | { ok: true; status: 'done'; data: unknown }
  | { ok: true; status: 'pending_approval'; run_id: string }
  | {
      ok: false;
      error: ActionRunErrorCode;
      http_status?: number;
      detail?: unknown;
      parameter?: string;
    };

/** A write action waits for a human when it says so, or when the agent only drafts. */
export function needsConfirmation(
  action: Pick<LoadedAction, 'kind' | 'requiresConfirmation'>,
  agentMode: 'draft_only' | 'autopilot' | 'intake_only' | 'answer'
): boolean {
  if (action.kind !== 'write') return false;
  return action.requiresConfirmation || agentMode === 'draft_only';
}

/**
 * Agent-triggered run: validate + bind identity, then either record it for
 * confirmation or execute it inline. Every outcome leaves an action_runs row.
 */
export async function runAgentAction(
  deps: ActionDeps,
  call: AgentActionCall
): Promise<ActionToolResult> {
  const { action } = call;
  const base = {
    org_id: action.orgId,
    data_action_id: action.id,
    conversation_id: call.conversationId,
    message_id: call.messageId,
    agent_id: call.agentId,
    trigger: 'agent',
  };

  const resolved = resolveActionValues(action.parameters, call.modelArgs, call.context);
  if (!resolved.ok) {
    await deps.supabase.from('action_runs').insert({
      ...base,
      state: 'failed',
      args: {},
      error_code: resolved.error,
      finished_at: new Date().toISOString(),
    });
    return { ok: false, error: resolved.error, parameter: resolved.key };
  }

  // Idempotency per inbound message (text pipeline): the pipeline is retried by
  // pg-boss after a later step failed, and a model may repeat a call within one
  // draft. The same action with the same values for the same message is never
  // sent to the end system twice — the earlier outcome is returned instead.
  if (call.messageId) {
    const prior = await findPriorRun(deps.supabase, action, call.messageId, resolved.values);
    if (prior) return prior;
  }

  if (await isRateLimited(deps.supabase, action.orgId)) {
    deps.logger.warn({ orgId: action.orgId, actionId: action.id }, 'data action rate limited');
    return { ok: false, error: 'rate_limited' };
  }

  const { data: inserted, error: insertError } = await deps.supabase
    .from('action_runs')
    .insert({
      ...base,
      state: call.confirm ? 'pending_approval' : 'running',
      args: resolved.values,
      ...(call.confirm ? {} : { started_at: new Date().toISOString() }),
    })
    .select('id')
    .single();
  if (insertError) throw insertError;
  const runId = (inserted as { id: string }).id;

  if (call.confirm) return { ok: true, status: 'pending_approval', run_id: runId };

  let outcome: ActionOutcome;
  try {
    outcome = await performActionCall(deps, action, resolved.values, runId);
  } catch (err) {
    // Unexpected (DB) failure: never leave the run in 'running'.
    deps.logger.error(
      { runId, actionId: action.id, err: toErrorInfo(err) },
      'data action failed unexpectedly'
    );
    outcome = failure('network');
  }
  await finishRun(deps.supabase, runId, outcome);
  deps.logger.info(
    {
      runId,
      actionId: action.id,
      ok: outcome.ok,
      httpStatus: outcome.httpStatus,
      latencyMs: outcome.latencyMs,
      ...(outcome.ok ? {} : { errorCode: outcome.errorCode }),
    },
    'data action run'
  );

  if (outcome.ok) return { ok: true, status: 'done', data: outcome.result };
  return {
    ok: false,
    error: outcome.errorCode,
    ...(outcome.httpStatus !== null ? { http_status: outcome.httpStatus } : {}),
    ...(outcome.result !== null && outcome.result !== undefined ? { detail: outcome.result } : {}),
  };
}

// --- queued runs (test + approved) -------------------------------------------------

export const ACTION_RUN_QUEUE = 'action.run';
/** No automatic retries: a write action must never be delivered twice by us. */
export const ACTION_RUN_RETRY_LIMIT = 0;

export interface ActionRunJob {
  runId: string;
}

/**
 * Execute a run in state 'queued' (a settings test run, or a run a team member
 * approved). The queued → running flip is the claim: a second delivery of the
 * same job finds nothing to claim and returns.
 */
export async function executeQueuedRun(deps: ActionDeps, runId: string): Promise<void> {
  const { data: claimed, error: claimError } = await deps.supabase
    .from('action_runs')
    .update({ state: 'running', started_at: new Date().toISOString() })
    .eq('id', runId)
    .eq('state', 'queued')
    .select('id, org_id, data_action_id, args, trigger');
  if (claimError) throw claimError;
  const run = (
    (claimed ?? []) as {
      id: string;
      org_id: string;
      data_action_id: string;
      args: unknown;
      trigger: string;
    }[]
  )[0];
  if (!run) return; // already claimed, decided otherwise, or gone

  let outcome: ActionOutcome;
  try {
    const { action, isActive } = await loadActionById(
      deps.supabase,
      run.org_id,
      run.data_action_id
    );
    if (!action) {
      outcome = failure('config_invalid');
    } else if (!isActive && run.trigger !== 'test') {
      // a test run may exercise a paused action; an approved run must not
      outcome = failure('action_inactive');
    } else {
      const raw =
        run.args !== null && typeof run.args === 'object' && !Array.isArray(run.args)
          ? (run.args as Record<string, unknown>)
          : {};
      const values = coerceActionValues(action.parameters, raw);
      outcome = values.ok
        ? await performActionCall(deps, action, values.values, run.id)
        : failure(values.error);
    }
  } catch (err) {
    deps.logger.error({ runId, err: toErrorInfo(err) }, 'queued data action failed unexpectedly');
    outcome = failure('network');
  }
  await finishRun(deps.supabase, run.id, outcome);
  deps.logger.info(
    {
      runId,
      trigger: run.trigger,
      ok: outcome.ok,
      httpStatus: outcome.httpStatus,
      latencyMs: outcome.latencyMs,
      ...(outcome.ok ? {} : { errorCode: outcome.errorCode }),
    },
    'queued data action run'
  );
}

/** Runs stuck in 'running' (worker died mid-call) are closed as failed. */
export async function failStaleRuns(supabase: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - ACTION_RUN_STALE_MS).toISOString();
  const { error } = await supabase
    .from('action_runs')
    .update({ state: 'failed', error_code: 'timeout', finished_at: new Date().toISOString() })
    .eq('state', 'running')
    .lt('started_at', cutoff);
  if (error && !isMissingRelationError(error)) throw error;
}
