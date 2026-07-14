import { embed } from './embeddings.js';
import type { KbChunkMatch } from './schemas.js';

// Shared RAG retrieval: embed the query and match org-scoped kb_chunks via the
// match_kb_chunks RPC (migration 0005). Used identically by the text pipeline
// (process-message draft step) and the voice kb_search tool (§9: "gleiche
// RAG-Funktion wie die Text-Pipeline").

export const MAX_EMBED_QUERY_CHARS = 24_000;

/** Minimal client surface so worker/web service-role clients both fit. */
type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export interface RetrieveResult {
  matches: KbChunkMatch[];
  /** Embedding cost for ai_runs logging. */
  costUsd: number;
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

  const { vectors, costUsd } = await embed([query.slice(0, MAX_EMBED_QUERY_CHARS)]);
  const queryVector = vectors[0];
  if (!queryVector) throw new Error('embedding returned no vector for the query');

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
