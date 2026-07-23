// zod schemas + inferred types for the Phase-4 AI pipeline. These are the
// contract at the AI boundary (CLAUDE.md §8.4): classify/extract responses are
// validated by the Anthropic SDK against these via zodOutputFormat, and the
// draft response is defensively parsed against DraftResultSchema.
import { z } from 'zod';

/** Classification of an inbound customer message. */
export const ClassificationResultSchema = z.object({
  language: z.enum(['de', 'en', 'other']),
  /** Short German keyword/phrase describing the intent (no PII). */
  intent: z.string().max(80),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  wants_human: z.boolean(),
  is_spam: z.boolean(),
  is_auto_reply: z.boolean(),
  /**
   * True when the message starts a NEW request unrelated to the provided
   * conversation history (also true without history). Currently a measurement
   * only — logged to ai_runs, drives no behavior (ticket-separation signal).
   */
  is_new_topic: z.boolean().default(false),
  /** Exactly one German sentence summarising the request (no PII). */
  summary: z.string().max(300),
});
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

/** Ticketisation / extraction of the real sender and request from a message. */
export const ExtractionResultSchema = z.object({
  contact: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  subject: z.string(),
  description: z.string(),
  category: z.string(),
  missing_fields: z.array(z.string()),
  questions: z.array(z.string()).max(3),
  confidence: z.number().min(0).max(1),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/**
 * RAG answer draft produced by the draft model. `confidence` is intentionally
 * an unbounded number here: the draft is defensively parsed from plain text, and
 * a slightly out-of-range confidence should be clamped into 0..1 (see
 * parseDraftResponse) rather than discarding an otherwise-valid reply.
 */
export const DraftResultSchema = z.object({
  reply: z.string(),
  confidence: z.number(),
  used_source_ids: z.array(z.string()),
});
export type DraftResult = z.infer<typeof DraftResultSchema>;

/**
 * Listwise rerank result (Haiku, stage 2 of the retrieval funnel): the indices
 * of the most relevant candidates, best first. Indices outside the candidate
 * range or duplicates are dropped defensively by the caller.
 */
export const RerankResultSchema = z.object({
  ranking: z.array(
    z.object({
      /** 1-based candidate number as presented in the prompt. */
      index: z.number().int(),
      /** Model's relevance judgement 0..1 (informational). */
      relevance: z.number(),
    })
  ),
});
export type RerankResult = z.infer<typeof RerankResultSchema>;

/**
 * Distilled learning pair (learning loop): a generalized, PII-free Q&A pair
 * proposed from a human answer. worth_learning=false marks non-reusable
 * exchanges (smalltalk, one-off case handling) — question/answer are ignored.
 */
export const LearnedPairSchema = z.object({
  worth_learning: z.boolean(),
  /** Generalized customer question, German, no PII. Empty when not worth learning. */
  question: z.string().max(500),
  /** Generalized answer, German, no PII. Empty when not worth learning. */
  answer: z.string().max(4000),
});
export type LearnedPair = z.infer<typeof LearnedPairSchema>;

/** A knowledge-base chunk returned by the match_kb_chunks RPC. */
export const KbChunkMatchSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  content: z.string(),
  similarity: z.number(),
});
export type KbChunkMatch = z.infer<typeof KbChunkMatchSchema>;
