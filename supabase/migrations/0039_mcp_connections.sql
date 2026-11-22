-- Zendori v2 — 0039: MCP connections (Phase 14a)
--
-- An org can connect a remote MCP server instead of describing every endpoint
-- of its system by hand. The server's tools are IMPORTED as data actions, so
-- everything 0035 built keeps applying unchanged: which agent may use an
-- action, confirmation in the inbox, the run log, the limits.
--
--   · api_connections.kind                 'http' (Phase 13) | 'mcp'
--   · api_connections.mcp_catalog          worker-written snapshot of the server's
--                                          tool list (zod: mcpCatalogSchema)
--   · api_connections.mcp_sync_*           request / claim / outcome of reading it
--   · data_actions.mcp_tool_name           set = the action is a tools/call of this tool
--   · data_actions.mcp_tool_hash           fingerprint of the tool definition at import
--   · data_actions.mcp_drift               worker-written: the server has since
--                                          changed the tool, or no longer offers it
--
-- Why a snapshot + hash: the model only ever sees the action the owner imported
-- and reviewed (name, description, parameters live in data_actions). A server
-- that later rewrites a tool description cannot reach the prompt; the worker
-- re-reads the list and flags the difference instead.
--
-- No new table and no new policy. The columns inherit the 0035 policies:
-- connections (incl. the catalog — it shows what a customer system can do) are
-- owner/admin only; actions are readable by members, writable by owner/admin.
-- All calls to the server are made by the worker (fixed egress IP, §12).
--
-- Rollout order: app deploy first (web and worker tolerate the missing columns:
-- 42703 / PGRST204 = feature not available yet), then apply this migration.

-- --- connections ----------------------------------------------------------------
alter table public.api_connections
  add column kind text not null default 'http' check (kind in ('http', 'mcp')),
  -- null until the first successful read; kept when a later read fails
  add column mcp_catalog jsonb,
  -- set by the owner ("Werkzeugliste aktualisieren") and by the worker's daily
  -- re-check; cleared by the worker together with the outcome
  add column mcp_sync_requested_at timestamptz,
  -- the worker's claim while a read is running (stale after two minutes)
  add column mcp_sync_started_at timestamptz,
  -- last attempt, successful or not
  add column mcp_synced_at timestamptz,
  -- content-free code of the last failed attempt, e.g. 'http_error:401'
  add column mcp_sync_error text
    check (mcp_sync_error is null or char_length(mcp_sync_error) <= 60);

-- worker scan: connections waiting for a read
create index api_connections_mcp_sync_idx
  on public.api_connections (mcp_sync_requested_at)
  where mcp_sync_requested_at is not null;

-- --- data actions ---------------------------------------------------------------
alter table public.data_actions
  -- the tool's name on the server (the model calls data_actions.name instead)
  add column mcp_tool_name text
    check (mcp_tool_name is null or char_length(mcp_tool_name) between 1 and 200),
  add column mcp_tool_hash text
    check (mcp_tool_hash is null or mcp_tool_hash ~ '^[0-9a-f]{64}$'),
  add column mcp_drift text
    check (mcp_drift is null or mcp_drift in ('changed', 'missing'));

-- An MCP action is a tools/call: a POST to the endpoint itself. method/path keep
-- their NOT NULL contract and are pinned for these rows; an HTTP action carries
-- none of the mcp_* values.
alter table public.data_actions
  add constraint data_actions_mcp_shape_check check (
    (mcp_tool_name is null and mcp_tool_hash is null and mcp_drift is null)
    or (mcp_tool_name is not null and mcp_tool_hash is not null
        and method = 'POST' and path = '/')
  );
