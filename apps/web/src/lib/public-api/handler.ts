import 'server-only';
import { NextResponse } from 'next/server';
import {
  apiError,
  authenticateApiKey,
  createLogger,
  createServiceRoleClient,
  type PublicApiContext,
  type PublicApiResult,
  type SupabaseClient,
} from '@zendori/core';
import { publicSupabaseEnv } from '@/lib/env';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';

// Shared request pipeline of the Zendori API (/api/v1/*, Phase 13d): rate limit
// by IP → API key → rate limit by key → handler. The handlers themselves live
// in @zendori/core (public-api.ts) and are unit-tested there; a route only maps
// its path to one of them.
//
// Every request gets its OWN service-role client, tagged with the key's
// connection as origin, so the outbox triggers (0036) do not report a change
// back to the end system that made it. Nothing of the request body, the key or
// the response is logged (§7) — only ids and the status.

const log = createLogger('api-v1');

export const MAX_BODY_BYTES = 64 * 1024;

export interface ApiRequestArgs {
  db: SupabaseClient;
  ctx: PublicApiContext;
  request: Request;
}

export type ApiHandler = (args: ApiRequestArgs) => Promise<PublicApiResult>;

function respond(result: PublicApiResult, extraHeaders?: Record<string, string>): Response {
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { 'cache-control': 'no-store', ...extraHeaders },
  });
}

const RATE_LIMITED = (): Response =>
  respond(apiError(429, 'rate_limited', 'too many requests — retry in a minute'), {
    'retry-after': '60',
  });

/**
 * The JSON body of a request, or undefined when it is missing, too large or
 * not JSON (the handler's validation then answers 422).
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return undefined;
  }
  if (text.length === 0 || text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A dynamic path segment as the caller meant it. Next may hand the segment
 * over still percent-encoded ("ext%3AERP-1"); decoding is attempted once and a
 * malformed sequence falls back to the raw value.
 */
export function pathRef(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function handleApiRequest(request: Request, handler: ApiHandler): Promise<Response> {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return respond(apiError(503, 'internal', 'the API is not available in this environment'));
  }
  if (!(await checkRateLimit('api-v1-ip', clientIp(request)))) return RATE_LIMITED();

  const { url } = publicSupabaseEnv();
  let ctx: PublicApiContext;
  try {
    const auth = await authenticateApiKey(
      createServiceRoleClient(url, serviceRoleKey),
      request.headers.get('authorization')
    );
    if (!auth.ok) return respond(auth.result);
    ctx = auth.context;
  } catch {
    log.error('api key lookup failed');
    return respond(apiError(500, 'internal', 'internal error'));
  }
  if (!(await checkRateLimit('api-v1-key', ctx.keyId))) return RATE_LIMITED();

  const db = createServiceRoleClient(url, serviceRoleKey, { originConnectionId: ctx.connectionId });
  try {
    const [result] = await Promise.all([
      handler({ db, ctx, request }),
      // bookkeeping for the key list ("zuletzt verwendet") — never fails a request
      db
        .from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', ctx.keyId)
        .then(() => undefined),
    ]);
    return respond(result);
  } catch (err) {
    log.error(
      {
        orgId: ctx.orgId,
        connectionId: ctx.connectionId,
        method: request.method,
        err: { name: (err as Error)?.name, code: (err as { code?: string })?.code },
      },
      'api request failed'
    );
    return respond(apiError(500, 'internal', 'internal error'));
  }
}
