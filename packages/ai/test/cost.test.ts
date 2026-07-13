import { describe, expect, it } from 'vitest';
import { anthropicCost, embeddingCost } from '../src/cost.js';

describe('anthropicCost', () => {
  it('computes haiku-4-5 cost from input/output tokens', () => {
    // 1M input @ $1.00 + 1M output @ $5.00 = $6.00
    expect(
      anthropicCost('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    ).toBeCloseTo(6.0, 10);
  });

  it('computes sonnet-4-6 cost from input/output tokens', () => {
    // 500k input @ $3.00/1M = $1.50 ; 200k output @ $15.00/1M = $3.00 → $4.50
    expect(
      anthropicCost('claude-sonnet-4-6', { inputTokens: 500_000, outputTokens: 200_000 })
    ).toBeCloseTo(4.5, 10);
  });

  it('returns 0 for a zero-token call', () => {
    expect(anthropicCost('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it('returns 0 for an unknown model (defensive)', () => {
    expect(anthropicCost('unknown-model', { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });
});

describe('embeddingCost', () => {
  it('computes text-embedding-3-small cost', () => {
    // 1M tokens @ $0.02/1M = $0.02
    expect(embeddingCost(1_000_000)).toBeCloseTo(0.02, 10);
  });

  it('returns 0 for zero tokens', () => {
    expect(embeddingCost(0)).toBe(0);
  });
});
