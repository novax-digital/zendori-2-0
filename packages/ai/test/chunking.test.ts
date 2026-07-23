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

  describe('contextHeader option', () => {
    const header = 'Quelle: Versandkosten & Lieferzeiten — https://example.com/versand';

    it('prepends the header to every chunk, not just the first', () => {
      const sentence = 'Die Lieferzeit beträgt in der Regel drei bis fünf Werktage innerhalb DE. ';
      const chunks = chunkText(sentence.repeat(80), { contextHeader: header });
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.content.startsWith(`${header}\n\n`)).toBe(true);
      }
    });

    it('includes the header in the token estimate', () => {
      const text = 'Die Wallbox lädt mit elf Kilowatt.';
      const [chunk] = chunkText(text, { contextHeader: header });
      const expected = `${header}\n\n${text}`;
      expect(chunk.content).toBe(expected);
      expect(chunk.tokenCount).toBe(Math.ceil(expected.length / 4));
    });

    it('does not distort chunk boundaries (header added after sizing)', () => {
      const sentence = 'Die Wallbox meldet einen roten Blinkcode und lädt seit gestern nicht. ';
      const text = sentence.repeat(80);
      const plain = chunkText(text);
      const withHeader = chunkText(text, { contextHeader: header });
      expect(withHeader).toHaveLength(plain.length);
      withHeader.forEach((chunk, index) => {
        expect(chunk.content).toBe(`${header}\n\n${plain[index].content}`);
      });
    });

    it('treats an empty or whitespace-only header as no header', () => {
      const text = 'Kurzer Eintrag ohne Kontext.';
      expect(chunkText(text, { contextHeader: '' })[0].content).toBe(text);
      expect(chunkText(text, { contextHeader: '   ' })[0].content).toBe(text);
      expect(chunkText(text, {})[0].content).toBe(text);
    });

    it('yields no chunks for empty text even with a header', () => {
      expect(chunkText('   ', { contextHeader: header })).toEqual([]);
    });
  });
});
