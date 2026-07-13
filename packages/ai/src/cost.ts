// Token cost accounting for the Phase-4 AI pipeline. Prices are the Anthropic /
// OpenAI list prices in USD per 1M tokens for the models fixed in CLAUDE.md §3.
// Kept isolated so ai_runs.cost_usd can be computed from a single source.

export interface TokenUsage {
  /** Prompt (input) tokens billed for the call. */
  inputTokens: number;
  /** Completion (output) tokens billed for the call. */
  outputTokens: number;
}

interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

const PER_MILLION = 1_000_000;

/** Anthropic list prices ($/1M tokens) for the models Phase 4 uses. */
const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
};

/** OpenAI text-embedding-3-small price ($/1M tokens). */
const EMBEDDING_PRICE_PER_MILLION = 0.02;

/**
 * Cost in USD for a single Anthropic call. Unknown models return 0 (defensive:
 * never throw while logging cost); the Phase-4 models are always known.
 */
export function anthropicCost(model: string, usage: TokenUsage): number {
  const pricing = ANTHROPIC_PRICING[model];
  if (!pricing) return 0;
  return (
    (usage.inputTokens / PER_MILLION) * pricing.input +
    (usage.outputTokens / PER_MILLION) * pricing.output
  );
}

/** Cost in USD for embedding `tokens` prompt tokens with text-embedding-3-small. */
export function embeddingCost(tokens: number): number {
  return (tokens / PER_MILLION) * EMBEDDING_PRICE_PER_MILLION;
}
