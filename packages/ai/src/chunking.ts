// Text chunking for the knowledge base. Produces overlapping, boundary-aligned
// chunks sized for embedding.
//
// Token approximation: we estimate ~4 characters per token (a common heuristic
// for mixed German/English prose). The binding target is CHUNKING in index.ts
// (targetTokens: 500, overlapTokens: 50); mirrored here as character budgets so
// this module has no import cycle with index.ts.
const CHARS_PER_TOKEN = 4;
const TARGET_CHARS = 500 * CHARS_PER_TOKEN; // ~2000 characters (~500 tokens)
const OVERLAP_CHARS = 50 * CHARS_PER_TOKEN; // ~200 characters (~50 tokens)

export interface TextChunk {
  content: string;
  /** Estimated token count (ceil(chars / 4)). */
  tokenCount: number;
}

export interface ChunkTextOptions {
  /**
   * Optional one-line provenance header (e.g. "Quelle: {title} — {url}")
   * prepended to EVERY chunk after sizing, so chunk boundaries stay
   * undistorted. The header becomes part of the chunk content on purpose: it
   * flows into the embedding, the generated german fts column, and the rerank
   * window, giving each chunk document context. Token counts include it.
   */
  contextHeader?: string;
}

/** Estimate token count from a character length. */
function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

/**
 * Split text into atomic pieces (sentences within paragraphs). Sentences longer
 * than the target size are hard-split so every piece is at most TARGET_CHARS.
 */
function toPieces(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (trimmedParagraph.length === 0) continue;
    // Break on sentence terminators, keeping the terminator with the sentence.
    const sentences = trimmedParagraph.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? [trimmedParagraph];
    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();
      if (trimmedSentence.length === 0) continue;
      if (trimmedSentence.length <= TARGET_CHARS) {
        pieces.push(trimmedSentence);
        continue;
      }
      // Sentence exceeds the target on its own: hard-split into char slices.
      for (let offset = 0; offset < trimmedSentence.length; offset += TARGET_CHARS) {
        pieces.push(trimmedSentence.slice(offset, offset + TARGET_CHARS));
      }
    }
  }
  return pieces;
}

/**
 * Build the overlap prefix for the next chunk from the tail of the current one.
 * Aligns to a word boundary where possible so the overlap starts on a whole word.
 */
function buildOverlap(chunkContent: string): string {
  if (chunkContent.length <= OVERLAP_CHARS) return chunkContent;
  const tail = chunkContent.slice(chunkContent.length - OVERLAP_CHARS);
  const firstSpace = tail.indexOf(' ');
  return firstSpace > 0 ? tail.slice(firstSpace + 1) : tail;
}

function makeChunk(content: string): TextChunk {
  const trimmed = content.trim();
  return { content: trimmed, tokenCount: estimateTokens(trimmed.length) };
}

/**
 * Split `text` into overlapping chunks of ~500 tokens with ~50 tokens of
 * overlap, breaking on paragraph and sentence boundaries where possible.
 * Whitespace-only chunks are dropped. With `options.contextHeader` set, the
 * header is prepended to every resulting chunk (after sizing).
 */
export function chunkText(text: string, options: ChunkTextOptions = {}): TextChunk[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) return [];

  const pieces = toPieces(normalized);
  if (pieces.length === 0) return [];

  const chunks: TextChunk[] = [];
  let current = '';

  for (const piece of pieces) {
    if (current.length > 0 && current.length + 1 + piece.length > TARGET_CHARS) {
      chunks.push(makeChunk(current));
      current = buildOverlap(current);
    }
    current = current.length > 0 ? `${current} ${piece}` : piece;
  }
  if (current.trim().length > 0) {
    chunks.push(makeChunk(current));
  }

  const nonEmpty = chunks.filter((chunk) => chunk.content.length > 0);
  const header = options.contextHeader?.trim();
  if (!header) return nonEmpty;
  // Prepend AFTER chunking so the header never distorts chunk boundaries;
  // makeChunk recomputes the token estimate from the final content.
  return nonEmpty.map((chunk) => makeChunk(`${header}\n\n${chunk.content}`));
}
