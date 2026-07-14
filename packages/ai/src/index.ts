// AI pipeline package. Classification, extraction/ticketization, RAG, drafting
// and confidence scoring are implemented in Phase 4; the constants below are the
// binding model/config decisions from CLAUDE.md §3 and are already referenced by
// docs and env validation.
//
// NOTE: the re-exports at the bottom of this file import these constants back
// (chunking/embeddings/anthropic). Keep the constant declarations above the
// `export *` lines so they are initialised before the cycle resolves.

export const AI_MODELS = {
  /** Classification + extraction/ticketization. */
  classify: 'claude-haiku-4-5',
  /** RAG answer drafts. */
  draft: 'claude-sonnet-4-6',
} as const;

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

export const CHUNKING = {
  targetTokens: 500,
  overlapTokens: 50,
} as const;

/** Steps logged to ai_runs ('rerank' since 0013 — stage 2 of retrieval). */
export type AiRunStep = 'classify' | 'extract' | 'retrieve' | 'rerank' | 'draft';

export * from './schemas.js';
export * from './prompts.js';
export * from './cost.js';
export * from './chunking.js';
export * from './embeddings.js';
export * from './retrieve.js';
export * from './anthropic.js';
