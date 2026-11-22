// Phase 14a — the MCP branch of a data-action run: instead of one HTTP request
// to `base_url + path`, the action is a tools/call on the org's MCP server.
// Everything around it stays in execute.ts (identity binding, confirmation,
// idempotency per message, the run row, the rate cap) — this file only turns
// validated values into the argument object and the tool result into an
// outcome. Never logs argument or result content (§7).
import {
  ACTION_RESULT_MAX_CHARS,
  buildActionArguments,
  capActionResult,
  mapMcpToolResult,
  type ActionValues,
} from '@zendori/core';
import { McpError, mcpCallTool, type CustomApiAuth } from '@zendori/integrations';
import { assertPublicUrl } from '../pipeline/index-source.js';
import type { ActionDeps, ActionOutcome, LoadedAction } from './execute.js';

const ERROR_RESULT_MAX_CHARS = 600;

function fromMcpError(err: McpError): ActionOutcome {
  // what the server said about the failure — bounded, for the run log and the model
  const detail =
    err.detail !== null
      ? capActionResult(
          err.rpcCode !== null ? { code: err.rpcCode, message: err.detail } : err.detail,
          ERROR_RESULT_MAX_CHARS
        )
      : null;
  switch (err.code) {
    case 'rpc_error':
      // the server understood the request and refused it (unknown tool, bad arguments)
      return {
        ok: false,
        errorCode: 'tool_error',
        httpStatus: err.httpStatus,
        latencyMs: null,
        result: detail,
      };
    case 'http_error':
    case 'redirected':
      return {
        ok: false,
        errorCode: err.code,
        httpStatus: err.httpStatus,
        latencyMs: null,
        result: err.code === 'http_error' ? detail : null,
      };
    default:
      return { ok: false, errorCode: err.code, httpStatus: null, latencyMs: null, result: null };
  }
}

/**
 * Call the action's tool ONCE with already-validated values. `runId` travels
 * as Idempotency-Key. Never retried: a call that may have reached the server
 * is not sent again.
 */
export async function performMcpCall(
  deps: Pick<ActionDeps, 'fetchImpl' | 'assertUrl'>,
  action: LoadedAction & { mcpToolName: string },
  endpointUrl: string,
  auth: CustomApiAuth,
  values: ActionValues,
  runId: string
): Promise<ActionOutcome> {
  const args = buildActionArguments(action.parameters, values);
  try {
    const { result, latencyMs } = await mcpCallTool(
      {
        url: endpointUrl,
        auth,
        timeoutMs: action.timeoutMs,
        fetchImpl: deps.fetchImpl,
        assertUrl: deps.assertUrl ?? assertPublicUrl,
      },
      { name: action.mcpToolName, arguments: args, requestId: runId }
    );
    const mapped = mapMcpToolResult(result, action.responseFields);
    if (mapped.isError) {
      return {
        ok: false,
        errorCode: 'tool_error',
        httpStatus: 200,
        latencyMs,
        result: capActionResult(mapped.value, ERROR_RESULT_MAX_CHARS),
      };
    }
    return {
      ok: true,
      httpStatus: 200,
      latencyMs,
      result: capActionResult(mapped.value, ACTION_RESULT_MAX_CHARS),
    };
  } catch (err) {
    if (err instanceof McpError) return fromMcpError(err);
    throw err;
  }
}
