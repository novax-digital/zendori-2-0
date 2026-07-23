import { embed } from './embeddings.js';
import { rerank } from './anthropic.js';
import type { KbChunkMatch } from './schemas.js';

// Shared RAG retrieval (§9: "gleiche RAG-Funktion wie die Text-Pipeline").
// Two-stage funnel since 0013:
//   stage 1  hybrid_kb_search — vector + keyword legs fused via RRF (pool)
//   stage 2  Haiku listwise rerank — cuts the pool to the final top-K
// retrieveKbChunks stays as the legacy vector-only path AND the fallback when
// the hybrid function is not migrated yet (worker-ahead-of-db skew).

/**
 * Embedding-query cap: ~1,000–1,400 German tokens — safely under the 8,191-token
 * text-embedding-3-small input limit (a 24k slice could exceed it and hard-fail
 * the pipeline), and one mean-pooled vector over more text barely encodes the
 * actual question anyway.
 */
export const MAX_EMBED_QUERY_CHARS = 4_000;
/** Keyword leg bound: websearch_to_tsquery over huge bodies is useless anyway. */
const MAX_KEYWORD_QUERY_CHARS = 1_000;
/**
 * Per-candidate content cap in the rerank prompt — keep ≥ chunking TARGET_CHARS
 * (500 tokens × 4 chars, see chunking.ts/CHUNKING) so the reranker judges full
 * chunks, not their first third; a truncated candidate showing no evidence gets
 * dropped by the "lieber weniger" rule even when the answer sits after the cut.
 * Cost: ~12k Haiku input tokens per 24-chunk pool.
 */
const RERANK_CANDIDATE_CHARS = 2_000;
/** Rerank query cap: the ask is near the top; quoted tails/forward headers are noise. */
const RERANK_QUERY_CHARS = 4_000;
/** Hard-fallback slice when the embedding API rejects the full-length query. */
const EMBED_FALLBACK_CHARS = 1_000;
/** Max OR-joined terms handed to the keyword leg. */
const MAX_KEYWORD_TERMS = 24;
/** Below this many distinct terms the precise AND semantics stay (chat/voice). */
const OR_TRANSFORM_MIN_TERMS = 7;

/** Minimal client surface so worker/web service-role clients both fit. */
type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

/** PostgREST "function not found" (pre-0013 schema) / PG undefined function. */
function isMissingFunction(error: { message: string; code?: string }): boolean {
  return (
    error.code === 'PGRST202' ||
    error.code === '42883' ||
    error.message.toLowerCase().includes('could not find the function')
  );
}

export interface RetrieveResult {
  matches: KbChunkMatch[];
  /** Embedding cost for ai_runs logging. */
  costUsd: number;
}

/**
 * Long prose bodies AND-compile to an unsatisfiable tsquery (websearch_to_tsquery
 * ANDs every non-stopword term), so the keyword leg — the one leg that reliably
 * finds product names, article numbers and error codes — returns nothing for
 * exactly the email/form messages it was built for. OR-join the distinct
 * significant terms instead; websearch_to_tsquery parses OR natively,
 * ts_rank_cd orders by matched-term density, and RRF + the Haiku rerank keep the
 * added recall clean. Short queries (chat, voice) keep the precise AND
 * semantics. Terms are word-chars/hyphen only, so no websearch operator
 * injection is possible. Pure; exported for unit tests.
 */
export function toKeywordQuery(text: string): string {
  const sliced = text.slice(0, MAX_KEYWORD_QUERY_CHARS);
  const terms = [...new Set(sliced.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]+/gu) ?? [])];
  if (terms.length < OR_TRANSFORM_MIN_TERMS) return sliced;
  return terms.slice(0, MAX_KEYWORD_TERMS).join(' OR ');
}

/**
 * Embed the query with a one-shot short-slice retry: a char cap cannot strictly
 * bound tokens (pathological unicode runs ~4 tokens/char), and an over-limit
 * input would otherwise hard-fail the whole retrieve step.
 */
async function embedQueryWithFallback(
  query: string
): Promise<{ vector: number[]; costUsd: number }> {
  try {
    const { vectors, costUsd } = await embed([query.slice(0, MAX_EMBED_QUERY_CHARS)]);
    const vector = vectors[0];
    if (!vector) throw new Error('embedding returned no vector for the query');
    return { vector, costUsd };
  } catch (err) {
    if (query.length <= EMBED_FALLBACK_CHARS) throw err;
    const { vectors, costUsd } = await embed([query.slice(0, EMBED_FALLBACK_CHARS)]);
    const vector = vectors[0];
    if (!vector) throw new Error('embedding returned no vector for the query');
    return { vector, costUsd };
  }
}

export async function retrieveKbChunks(
  supabase: RpcClient,
  orgId: string,
  query: string,
  options: {
    matchThreshold?: number;
    matchCount?: number;
    /**
     * Knowledge bases to search (0012). null/undefined = all org knowledge
     * (force-draft / agent-less contexts); [] = nothing (an agent whose owner
     * linked no bases deliberately knows nothing).
     */
    knowledgeBaseIds?: string[] | null;
  } = {}
): Promise<RetrieveResult> {
  // Short-circuit the empty filter: no bases can never match — skip the
  // embedding call entirely (no cost, no RPC).
  if (options.knowledgeBaseIds && options.knowledgeBaseIds.length === 0) {
    return { matches: [], costUsd: 0 };
  }

  const { vector: queryVector, costUsd } = await embedQueryWithFallback(query);

  // Omit the filter arg when unfiltered: PostgREST resolves RPCs by the exact
  // set of named args, so a 4-key body matches BOTH the pre-0012 function and
  // the new one (p_knowledge_base_ids default null) — schema-skew safe.
  const args: Record<string, unknown> = {
    p_org_id: orgId,
    p_embedding: queryVector,
    p_match_threshold: options.matchThreshold ?? 0.3,
    p_match_count: options.matchCount ?? 6,
  };
  if (options.knowledgeBaseIds != null) args.p_knowledge_base_ids = options.knowledgeBaseIds;
  const { data, error } = await supabase.rpc('match_kb_chunks', args);
  if (error) throw new Error(`match_kb_chunks failed: ${error.message}`);

  return { matches: (data ?? []) as KbChunkMatch[], costUsd };
}

/**
 * Defensive mapping of a model ranking onto the candidate pool: 1-based
 * indices, out-of-range and duplicates dropped, capped at finalCount. Pure.
 */
export function applyRanking<T>(
  pool: T[],
  ranking: { index: number }[],
  finalCount: number
): T[] {
  const seen = new Set<number>();
  const result: T[] = [];
  for (const entry of ranking) {
    const poolIndex = entry.index - 1;
    if (!Number.isInteger(poolIndex) || poolIndex < 0 || poolIndex >= pool.length) continue;
    if (seen.has(poolIndex)) continue;
    seen.add(poolIndex);
    result.push(pool[poolIndex]!);
    if (result.length >= finalCount) break;
  }
  return result;
}

export interface RetrieveRelevantResult {
  matches: KbChunkMatch[];
  /** Embedding cost (stage 1) for ai_runs logging. */
  embedCostUsd: number;
  /** 'hybrid' (0013) or 'vector' (pre-0013 fallback via match_kb_chunks). */
  searchMode: 'hybrid' | 'vector';
  /** Present when the Haiku rerank (stage 2) ran successfully. */
  rerank?: { costUsd: number; latencyMs: number; poolSize: number; model: string };
  /** True when reranking was attempted but failed (fusion order used instead). */
  rerankFailed?: boolean;
}

/**
 * Full two-stage retrieval: hybrid candidate pool → Haiku rerank → top-K.
 * Failure semantics (all non-fatal by design):
 *   - hybrid function missing (pre-0013) → legacy vector search, no rerank
 *   - rerank disabled/unneeded (pool ≤ finalCount) → fusion order
 *   - rerank throws → fusion order + rerankFailed for the caller's logging
 */
export async function retrieveRelevantChunks(
  supabase: RpcClient,
  orgId: string,
  query: string,
  options: {
    knowledgeBaseIds?: string[] | null;
    /**
     * Text for the keyword (tsquery) leg. Defaults to `query`. Callers that
     * contextualise `query` with subject/history MUST pass the bare current
     * message here — the 1,000-char tsquery slice would otherwise be consumed
     * by the context and drop the actual question from the keyword leg.
     */
    keywordQuery?: string;
    /** Chunks handed to the draft prompt. Default 6 (legacy behavior). */
    finalCount?: number;
    /** Stage-1 candidate pool. Default 24. */
    poolCount?: number;
    /** Disable stage 2 (voice: latency-sensitive live calls). Default true. */
    rerank?: boolean;
    /**
     * Vector-leg noise gate (0014). Leave unset for the default 0.15 — safe
     * ONLY together with the rerank stage. Callers that disable reranking
     * (voice) MUST pass 0.3 to restore the legacy cutoff.
     */
    minSimilarity?: number;
    /** Company name for the rerank prompt. */
    companyName?: string;
  } = {}
): Promise<RetrieveRelevantResult> {
  const finalCount = options.finalCount ?? 6;
  const poolCount = options.poolCount ?? 24;

  // [] = the agent has no linked bases: knows nothing, costs nothing.
  if (options.knowledgeBaseIds && options.knowledgeBaseIds.length === 0) {
    return { matches: [], embedCostUsd: 0, searchMode: 'hybrid' };
  }

  const { vector: queryVector, costUsd: embedCostUsd } = await embedQueryWithFallback(query);

  // --- stage 1: hybrid pool -------------------------------------------------
  const hybridArgs: Record<string, unknown> = {
    p_org_id: orgId,
    p_query: toKeywordQuery(options.keywordQuery ?? query),
    p_embedding: queryVector,
    p_match_count: poolCount,
  };
  if (options.knowledgeBaseIds != null) hybridArgs.p_knowledge_base_ids = options.knowledgeBaseIds;
  // Omitted unless set: a 6-key body against the pre-0014 function 404s into
  // the legacy fallback below — which already enforces the 0.3 cutoff.
  if (options.minSimilarity != null) hybridArgs.p_min_similarity = options.minSimilarity;
  const { data, error } = await supabase.rpc('hybrid_kb_search', hybridArgs);
  if (error) {
    if (!isMissingFunction(error)) throw new Error(`hybrid_kb_search failed: ${error.message}`);
    // Pre-0013 schema: fall back to the legacy vector search — exactly the old
    // behavior (threshold 0.3, finalCount, no rerank). Costs one extra embed
    // call? No: reuse the vector we already computed via the legacy RPC args.
    const legacyArgs: Record<string, unknown> = {
      p_org_id: orgId,
      p_embedding: queryVector,
      p_match_threshold: 0.3,
      p_match_count: finalCount,
    };
    if (options.knowledgeBaseIds != null) legacyArgs.p_knowledge_base_ids = options.knowledgeBaseIds;
    const legacy = await supabase.rpc('match_kb_chunks', legacyArgs);
    if (legacy.error) throw new Error(`match_kb_chunks failed: ${legacy.error.message}`);
    return {
      matches: (legacy.data ?? []) as KbChunkMatch[],
      embedCostUsd,
      searchMode: 'vector',
    };
  }
  const pool = (data ?? []) as KbChunkMatch[];

  // --- stage 2: rerank --------------------------------------------------------
  // Runs whenever there are candidates: the reranker does not just reorder, it
  // FILTERS — that filtering is what makes the loosened 0.15 vector gate safe.
  // Only rerank:false callers (voice, which passes minSimilarity 0.3) skip it.
  if (options.rerank === false || pool.length === 0) {
    return { matches: pool.slice(0, finalCount), embedCostUsd, searchMode: 'hybrid' };
  }

  const started = Date.now();
  try {
    const { result, costUsd } = await rerank({
      companyName: options.companyName ?? 'unser Unternehmen',
      query: query.slice(0, RERANK_QUERY_CHARS),
      candidates: pool.map((m) => m.content.slice(0, RERANK_CANDIDATE_CHARS)),
      topK: finalCount,
    });
    const rerankInfo = {
      costUsd,
      latencyMs: Date.now() - started,
      poolSize: pool.length,
      model: 'claude-haiku-4-5',
    };
    // An EMPTY ranking is a legitimate verdict ("none of these help" — the
    // prompt explicitly allows it): trust it, hand the draft zero sources
    // (→ honest low-confidence answer → handoff) and log the billed call.
    if (result.ranking.length === 0) {
      return { matches: [], embedCostUsd, searchMode: 'hybrid', rerank: rerankInfo };
    }
    const reranked = applyRanking(pool, result.ranking, finalCount);
    // A NON-empty ranking that maps to nothing is garbage (invalid indices):
    // treat as failure and fall back to fusion order.
    if (reranked.length === 0) {
      return {
        matches: pool.slice(0, finalCount),
        embedCostUsd,
        searchMode: 'hybrid',
        rerankFailed: true,
      };
    }
    return { matches: reranked, embedCostUsd, searchMode: 'hybrid', rerank: rerankInfo };
  } catch {
    // Reranking is an optimisation — never fail retrieval because of it.
    return {
      matches: pool.slice(0, finalCount),
      embedCostUsd,
      searchMode: 'hybrid',
      rerankFailed: true,
    };
  }
}
