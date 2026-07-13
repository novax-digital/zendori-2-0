// OpenAI embeddings (text-embedding-3-small, 1536 dim) via fetch — no SDK, one
// dependency fewer. OPENAI_API_KEY is read lazily from process.env so this
// package pulls no AI env into apps/web (CLAUDE.md §4).
import { z } from 'zod';
import { EMBEDDING_MODEL } from './index.js';
import { embeddingCost } from './cost.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** OpenAI accepts up to 2048 inputs per request; we cap conservatively at 100. */
const MAX_BATCH_SIZE = 100;

const embeddingResponseSchema = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
  usage: z.object({ prompt_tokens: z.number() }),
});

function getOpenAiConfig(): { apiKey: string; baseUrl: string } {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY ist nicht gesetzt.');
  const baseUrl = (process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  return { apiKey, baseUrl };
}

/**
 * Embed a batch of texts. Returns vectors in the same order as `texts` plus the
 * total embedding cost in USD. Batches requests of up to 100 inputs.
 */
export async function embed(texts: string[]): Promise<{ vectors: number[][]; costUsd: number }> {
  if (texts.length === 0) return { vectors: [], costUsd: 0 };

  const { apiKey, baseUrl } = getOpenAiConfig();
  const vectors: number[][] = [];
  let totalTokens = 0;

  for (let start = 0; start < texts.length; start += MAX_BATCH_SIZE) {
    const batch = texts.slice(start, start + MAX_BATCH_SIZE);
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI-Embeddings-Anfrage fehlgeschlagen (HTTP ${response.status}).`);
    }
    const parsed = embeddingResponseSchema.parse(await response.json());
    // The API may return items out of order; sort by index to preserve input order.
    const ordered = [...parsed.data].sort((a, b) => a.index - b.index);
    for (const item of ordered) {
      vectors.push(item.embedding);
    }
    totalTokens += parsed.usage.prompt_tokens;
  }

  return { vectors, costUsd: embeddingCost(totalTokens) };
}

/** Convenience wrapper: embed a single query string. */
export async function embedQuery(text: string): Promise<{ vector: number[]; costUsd: number }> {
  const { vectors, costUsd } = await embed([text]);
  const vector = vectors[0];
  if (!vector) throw new Error('OpenAI-Embeddings lieferte kein Ergebnis.');
  return { vector, costUsd };
}
