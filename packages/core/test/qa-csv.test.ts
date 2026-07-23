import { describe, expect, it } from 'vitest';
import { MAX_QA_PAIRS, detectCsvDelimiter, parseQaCsv } from '../src/qa-csv.js';

describe('detectCsvDelimiter', () => {
  it('prefers semicolons (German Excel default)', () => {
    expect(detectCsvDelimiter('Frage;Antwort\na;b')).toBe(';');
  });

  it('falls back to comma', () => {
    expect(detectCsvDelimiter('question,answer\na,b')).toBe(',');
  });

  it('ignores delimiters inside quoted fields', () => {
    expect(detectCsvDelimiter('"a;b;c",antwort')).toBe(',');
  });
});

describe('parseQaCsv', () => {
  it('parses simple semicolon rows and skips the header', () => {
    const result = parseQaCsv('Frage;Antwort\nWie lange ist die Lieferzeit?;3 Tage\nGibt es Garantie?;2 Jahre\n');
    expect(result.hadHeader).toBe(true);
    expect(result.skipped).toBe(0);
    expect(result.pairs).toEqual([
      { question: 'Wie lange ist die Lieferzeit?', answer: '3 Tage' },
      { question: 'Gibt es Garantie?', answer: '2 Jahre' },
    ]);
  });

  it('works without a header (first row is data)', () => {
    const result = parseQaCsv('Was kostet der Versand?,4,90 Euro');
    expect(result.hadHeader).toBe(false);
    // extra columns beyond the second are ignored
    expect(result.pairs).toEqual([{ question: 'Was kostet der Versand?', answer: '4' }]);
  });

  it('handles quoted fields with embedded delimiters, quotes and newlines', () => {
    const csv = 'Frage;Antwort\n"Was gilt bei ""Expresslieferung"" ?";"Zeile 1;\nZeile 2"';
    const result = parseQaCsv(csv);
    expect(result.pairs).toEqual([
      { question: 'Was gilt bei "Expresslieferung" ?', answer: 'Zeile 1;\nZeile 2' },
    ]);
  });

  it('counts rows with empty question or answer as skipped', () => {
    const result = parseQaCsv('Frage;Antwort\n;nur Antwort\nnur Frage;\nQ;A');
    expect(result.pairs).toEqual([{ question: 'Q', answer: 'A' }]);
    expect(result.skipped).toBe(2);
  });

  it('ignores blank lines and strips a UTF-8 BOM', () => {
    const result = parseQaCsv('﻿Frage;Antwort\n\nQ;A\n\n');
    expect(result.hadHeader).toBe(true);
    expect(result.pairs).toEqual([{ question: 'Q', answer: 'A' }]);
  });

  it('caps the number of pairs at MAX_QA_PAIRS', () => {
    const csv = Array.from({ length: MAX_QA_PAIRS + 5 }, (_, i) => `F${i};A${i}`).join('\n');
    const result = parseQaCsv(csv);
    expect(result.pairs).toHaveLength(MAX_QA_PAIRS);
    expect(result.skipped).toBe(5);
  });

  it('a header-only or garbage file yields zero pairs without throwing', () => {
    expect(parseQaCsv('Frage;Antwort').pairs).toHaveLength(0);
    expect(parseQaCsv('kein csv inhalt').pairs).toHaveLength(0);
    expect(parseQaCsv('').pairs).toHaveLength(0);
  });
});

