// Q&A CSV import for the knowledge base: parses a two-column CSV
// (Frage;Antwort — German Excel default is ';', ',' is auto-detected) into
// question/answer pairs. Dependency-free RFC-4180-style parser: quoted fields,
// "" escapes, CR/LF line endings. Shared contract between apps/web (validates
// at upload time) and apps/worker (indexes each pair as its own chunk).

export interface QaPair {
  question: string;
  answer: string;
}

export interface QaCsvResult {
  pairs: QaPair[];
  /** Data rows dropped because question or answer was empty. */
  skipped: number;
  /** True when the first row looked like a header (Frage/Antwort …) and was dropped. */
  hadHeader: boolean;
}

/** Hard cap on imported pairs — enough for any real FAQ, bounds index cost. */
export const MAX_QA_PAIRS = 2_000;
/** Per-field cap; overly long cells are truncated (chunking splits long answers anyway). */
export const MAX_QA_FIELD_CHARS = 8_000;

const HEADER_QUESTION = /^(frage|fragen|question)s?$/i;
const HEADER_ANSWER = /^(antwort|antworten|answer)s?$/i;

/**
 * Split raw CSV text into rows of fields, honoring quotes ("" escapes a quote)
 * so delimiters and newlines inside quoted fields survive. Pure.
 */
function parseCsvRows(csv: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && csv[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/**
 * Pick the delimiter (';' vs ',') by counting occurrences OUTSIDE quotes in the
 * first non-empty line — German Excel exports use ';', everything else ','.
 */
export function detectCsvDelimiter(csv: string): ';' | ',' {
  const firstLine = csv.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  let semicolons = 0;
  let commas = 0;
  let inQuotes = false;
  for (const char of firstLine) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char === ';') semicolons += 1;
    else if (!inQuotes && char === ',') commas += 1;
  }
  return semicolons >= commas && semicolons > 0 ? ';' : ',';
}

/**
 * Parse a Q&A CSV: first column = question, second column = answer, extra
 * columns ignored. An optional header row (Frage/Antwort, Question/Answer) is
 * skipped. Rows with an empty question or answer are counted in `skipped`.
 * Never throws — a malformed file simply yields zero pairs.
 */
export function parseQaCsv(csv: string): QaCsvResult {
  const normalized = csv.replace(/^﻿/, ''); // strip BOM (Excel UTF-8 export)
  const delimiter = detectCsvDelimiter(normalized);
  const rows = parseCsvRows(normalized, delimiter);

  const pairs: QaPair[] = [];
  let skipped = 0;
  let hadHeader = false;
  let sawDataRow = false;

  for (const fields of rows) {
    const question = (fields[0] ?? '').trim();
    const answer = (fields[1] ?? '').trim();
    if (question.length === 0 && answer.length === 0) continue; // blank line
    if (!sawDataRow && HEADER_QUESTION.test(question) && HEADER_ANSWER.test(answer)) {
      hadHeader = true;
      sawDataRow = true;
      continue;
    }
    sawDataRow = true;
    if (question.length === 0 || answer.length === 0) {
      skipped += 1;
      continue;
    }
    if (pairs.length >= MAX_QA_PAIRS) {
      skipped += 1;
      continue;
    }
    pairs.push({
      question: question.slice(0, MAX_QA_FIELD_CHARS),
      answer: answer.slice(0, MAX_QA_FIELD_CHARS),
    });
  }

  return { pairs, skipped, hadHeader };
}
