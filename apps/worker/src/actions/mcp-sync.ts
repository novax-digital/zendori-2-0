// Phase 14a — reading an MCP server's tool list ("sync"). The web app only sets
// api_connections.mcp_sync_requested_at; the WORKER connects to the customer's
// server (fixed egress IP, SSRF guard — §12), stores the list as a snapshot
// (mcp_catalog) and compares every imported action with it:
//   · the tool's definition changed since the import  → data_actions.mcp_drift = 'changed'
//   · the server no longer offers the tool            → 'missing'
// The model keeps seeing the IMPORTED definition either way — this is how a
// silently rewritten tool description gets noticed instead of reaching a prompt.
//
// A sync doubles as the connection test (address, credentials, protocol). The
// worker also re-requests it once a day for active connections. Logs carry ids,
// counts and error codes only (§7).
import {
  MCP_CATALOG_MAX_TOOLS,
  apiConnectionConfigSchema,
  computeMcpDrift,
  isMissingColumnError,
  isMissingRelationError,
  mcpCatalogSchema,
  toCatalogTool,
  type McpCatalog,
  type McpSyncErrorCode,
  type SupabaseClient,
} from '@zendori/core';
import { McpError, mcpListTools } from '@zendori/integrations';
import { toErrorInfo } from '../db.js';
import { assertPublicUrl } from '../pipeline/index-source.js';
import { decryptConnectionSecrets, type ActionDeps } from './execute.js';

export const MCP_SYNC_QUEUE = 'mcp.sync';
/** The row is the source of truth: a failed read is recorded, never redelivered. */
export const MCP_SYNC_RETRY_LIMIT = 0;
export const MCP_SYNC_TIMEOUT_MS = 20_000;
/** A claim older than this belongs to a worker that died mid-read. */
export const MCP_SYNC_STALE_MS = 2 * 60_000;
/** Active connections are re-read this often to notice changed tools. */
export const MCP_RESYNC_AFTER_MS = 24 * 60 * 60_000;

export interface McpSyncJob {
  connectionId: string;
}

interface ClaimedConnection {
  id: string;
  org_id: string;
  base_url: string;
  config: unknown;
  mcp_sync_requested_at: string | null;
}

const CLAIM_COLUMNS = 'id, org_id, base_url, config, mcp_sync_requested_at';

/**
 * Claim a connection for one read by stamping mcp_sync_started_at. A second
 * delivery of the same job finds the stamp and returns; a stamp left behind by
 * a dead worker can be taken over once it is stale.
 */
async function claimConnection(
  supabase: SupabaseClient,
  connectionId: string,
  nowMs: number
): Promise<ClaimedConnection | null> {
  const startedAt = new Date(nowMs).toISOString();
  const fresh = await supabase
    .from('api_connections')
    .update({ mcp_sync_started_at: startedAt })
    .eq('id', connectionId)
    .eq('kind', 'mcp')
    .is('mcp_sync_started_at', null)
    .select(CLAIM_COLUMNS);
  if (fresh.error) throw fresh.error;
  const claimed = ((fresh.data ?? []) as unknown as ClaimedConnection[])[0];
  if (claimed) return claimed;

  const stale = await supabase
    .from('api_connections')
    .update({ mcp_sync_started_at: startedAt })
    .eq('id', connectionId)
    .eq('kind', 'mcp')
    .lt('mcp_sync_started_at', new Date(nowMs - MCP_SYNC_STALE_MS).toISOString())
    .select(CLAIM_COLUMNS);
  if (stale.error) throw stale.error;
  return ((stale.data ?? []) as unknown as ClaimedConnection[])[0] ?? null;
}

function syncErrorCode(err: McpError): string {
  const code: McpSyncErrorCode = err.code;
  return (code === 'http_error' || code === 'redirected') && err.httpStatus !== null
    ? `${code}:${err.httpStatus}`
    : code;
}

/** Flag imported actions whose tool changed or disappeared; clear the flag when it matches again. */
async function updateDrift(
  supabase: SupabaseClient,
  connection: Pick<ClaimedConnection, 'id' | 'org_id'>,
  catalog: McpCatalog
): Promise<number> {
  const { data, error } = await supabase
    .from('data_actions')
    .select('id, mcp_tool_name, mcp_tool_hash, mcp_drift')
    .eq('org_id', connection.org_id)
    .eq('connection_id', connection.id);
  if (error) throw error;
  const byName = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  let flagged = 0;
  for (const row of (data ?? []) as {
    id: string;
    mcp_tool_name: string | null;
    mcp_tool_hash: string | null;
    mcp_drift: string | null;
  }[]) {
    if (!row.mcp_tool_name) continue;
    const drift = computeMcpDrift(
      row.mcp_tool_hash,
      byName.get(row.mcp_tool_name),
      catalog.truncated
    );
    if (drift === undefined) continue;
    if (drift !== null) flagged += 1;
    if (drift === (row.mcp_drift ?? null)) continue;
    const { error: updateError } = await supabase
      .from('data_actions')
      .update({ mcp_drift: drift })
      .eq('id', row.id);
    if (updateError) throw updateError;
  }
  return flagged;
}

/**
 * Read the tool list of one MCP connection and store the outcome. Every path
 * ends with the request cleared and the claim released, so the settings page
 * (which polls mcp_sync_requested_at) always gets an answer. A failed read
 * keeps the previous catalog and records an error code.
 */
export async function syncMcpConnection(
  deps: ActionDeps,
  connectionId: string,
  nowMs: number = Date.now()
): Promise<void> {
  const connection = await claimConnection(deps.supabase, connectionId, nowMs);
  if (!connection) return; // already running, not an MCP connection, or gone

  if (!connection.mcp_sync_requested_at) {
    // a job that outlived its request (the read it was queued for is done)
    const { error } = await deps.supabase
      .from('api_connections')
      .update({ mcp_sync_started_at: null })
      .eq('id', connection.id);
    if (error) throw error;
    return;
  }

  let catalog: McpCatalog | null = null;
  let errorCode: string | null = null;
  try {
    const config = apiConnectionConfigSchema.safeParse(connection.config ?? {});
    const secrets = config.success
      ? await decryptConnectionSecrets(config.data, deps.masterKey)
      : null;
    if (!secrets) {
      errorCode = 'config_invalid' satisfies McpSyncErrorCode;
    } else {
      const list = await mcpListTools(
        {
          url: connection.base_url,
          auth: secrets.auth,
          timeoutMs: MCP_SYNC_TIMEOUT_MS,
          fetchImpl: deps.fetchImpl,
          assertUrl: deps.assertUrl ?? assertPublicUrl,
        },
        { maxTools: MCP_CATALOG_MAX_TOOLS }
      );
      const parsed = mcpCatalogSchema.safeParse({
        server: list.server,
        tools: list.tools.map(toCatalogTool),
        truncated: list.truncated,
      });
      if (parsed.success) catalog = parsed.data;
      else errorCode = 'protocol_error' satisfies McpSyncErrorCode;
    }
  } catch (err) {
    if (err instanceof McpError) {
      errorCode = syncErrorCode(err);
    } else {
      deps.logger.error({ connectionId, err: toErrorInfo(err) }, 'mcp sync failed unexpectedly');
      errorCode = 'internal' satisfies McpSyncErrorCode;
    }
  }

  let flagged = 0;
  if (catalog) {
    try {
      flagged = await updateDrift(deps.supabase, connection, catalog);
    } catch (err) {
      // the catalog is still worth storing — the flags catch up on the next read
      deps.logger.warn({ connectionId, err: toErrorInfo(err) }, 'mcp drift update failed');
    }
  }

  const { error: finishError } = await deps.supabase
    .from('api_connections')
    .update({
      ...(catalog ? { mcp_catalog: catalog } : {}),
      mcp_synced_at: new Date(nowMs).toISOString(),
      mcp_sync_error: errorCode,
      mcp_sync_requested_at: null,
      mcp_sync_started_at: null,
    })
    .eq('id', connection.id);
  if (finishError) throw finishError;

  deps.logger.info(
    {
      connectionId,
      ok: errorCode === null,
      ...(catalog ? { tools: catalog.tools.length, truncated: catalog.truncated, flagged } : {}),
      ...(errorCode ? { errorCode } : {}),
    },
    'mcp tool list read'
  );
}

/**
 * Ask for a fresh read of every active MCP connection whose last attempt is
 * older than a day (and that has none pending). Silent before migration 0039.
 */
export async function requestStaleMcpSyncs(
  supabase: SupabaseClient,
  nowMs: number = Date.now()
): Promise<void> {
  const { data, error } = await supabase
    .from('api_connections')
    .select('id, mcp_synced_at, mcp_sync_requested_at')
    .eq('kind', 'mcp')
    .eq('is_active', true)
    .limit(500);
  if (error) {
    if (isMissingColumnError(error) || isMissingRelationError(error)) return;
    throw error;
  }
  const cutoff = nowMs - MCP_RESYNC_AFTER_MS;
  const due = (
    (data ?? []) as {
      id: string;
      mcp_synced_at: string | null;
      mcp_sync_requested_at: string | null;
    }[]
  )
    .filter(
      (row) =>
        !row.mcp_sync_requested_at && (!row.mcp_synced_at || Date.parse(row.mcp_synced_at) < cutoff)
    )
    .map((row) => row.id);
  if (due.length === 0) return;
  const { error: updateError } = await supabase
    .from('api_connections')
    .update({ mcp_sync_requested_at: new Date(nowMs).toISOString() })
    .in('id', due);
  if (updateError) throw updateError;
}
