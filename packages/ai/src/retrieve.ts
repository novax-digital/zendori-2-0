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
  options: { matchThreshold?: number; matchCount?: number } = {}
): Promise<RetrieveResult> {
  const { vectors, costUsd } = await embed([query.slice(0, MAX_EMBED_QUERY_CHARS)]);
  const queryVector = vectors[0];
  if (!queryVector) throw new Error('embedding returned no vector for the query');

  const { data, error } = await supabase.rpc('match_kb_chunks', {
    p_org_id: orgId,
    p_embedding: queryVector,
    p_match_threshold: options.matchThreshold ?? 0.3,
    p_match_count: options.matchCount ?? 6,
  });
  if (error) throw new Error(`match_kb_chunks failed: ${error.message}`);

  return { matches: (data ?? []) as KbChunkMatch[], costUsd };
}
