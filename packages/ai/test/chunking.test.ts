import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/chunking.js';

describe('chunkText', () => {
  it('returns no chunks for empty or whitespace-only input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n \t ')).toEqual([]);
  });

  it('returns a single chunk for short text with the estimated token count', () => {
    const text = 'Guten Tag, meine Wallbox lädt nicht mehr. Können Sie helfen?';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(text);
    expect(chunks[0].tokenCount).toBe(Math.ceil(text.length / 4));
  });

  it('splits long text into multiple overlapping chunks', () => {
    const sentence = 'Die Wallbox meldet einen roten Blinkcode und lädt seit gestern nicht mehr. ';
    const text = sentence.repeat(80); // ~6000 chars → several chunks
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0);
      // Target ~2000 chars + ~200 overlap; stay within a safe upper bound.
      expect(chunk.content.length).toBeLessThanOrEqual(2500);
      expect(chunk.tokenCount).toBe(Math.ceil(chunk.content.length / 4));
    }

    // Consecutive chunks overlap: the start of the next chunk appears in the
    // previous one.
    const nextStart = chunks[1].content.slice(0, 30);
    expect(chunks[0].content).toContain(nextStart);
  });

  it('hard-splits a single sentence longer than the target size', () => {
    const giant = 'wort '.repeat(1000); // ~5000 chars, no sentence terminators
    const chunks = chunkText(giant);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(2500);
    }
  });

  it('drops empty paragraphs and keeps content non-empty', () => {
    const text = 'Erster Absatz.\n\n\n\n   \n\nZweiter Absatz.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('Erster Absatz.');
    expect(chunks[0].content).toContain('Zweiter Absatz.');
  });
});
