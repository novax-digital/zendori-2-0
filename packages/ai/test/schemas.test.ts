import { describe, expect, it } from 'vitest';
import {
  ClassificationResultSchema,
  DraftResultSchema,
  ExtractionResultSchema,
  KbChunkMatchSchema,
} from '../src/schemas.js';

describe('ClassificationResultSchema', () => {
  const valid = {
    language: 'de',
    intent: 'Störung Wallbox',
    priority: 'high',
    wants_human: false,
    is_spam: false,
    is_auto_reply: false,
    summary: 'Die Wallbox lädt nicht mehr.',
  };

  it('parses a valid classification', () => {
    expect(ClassificationResultSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an invalid enum value', () => {
    expect(ClassificationResultSchema.safeParse({ ...valid, priority: 'critical' }).success).toBe(
      false
    );
  });

  it('rejects an intent that is too long', () => {
    expect(ClassificationResultSchema.safeParse({ ...valid, intent: 'x'.repeat(81) }).success).toBe(
      false
    );
  });

  it('rejects a missing field', () => {
    const { summary: _summary, ...withoutSummary } = valid;
    expect(ClassificationResultSchema.safeParse(withoutSummary).success).toBe(false);
  });
});

describe('ExtractionResultSchema', () => {
  const valid = {
    contact: { name: 'Kai Beispiel', email: 'kai@example.com', phone: null },
    subject: 'Frage zur Rechnung',
    description: 'Ich habe eine Frage zu meiner letzten Rechnung.',
    category: 'Frage',
    missing_fields: [],
    questions: [],
    confidence: 0.9,
  };

  it('parses a valid extraction with nullable contact fields', () => {
    expect(ExtractionResultSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects more than three questions', () => {
    expect(
      ExtractionResultSchema.safeParse({ ...valid, questions: ['a', 'b', 'c', 'd'] }).success
    ).toBe(false);
  });

  it('rejects a confidence outside 0..1', () => {
    expect(ExtractionResultSchema.safeParse({ ...valid, confidence: 1.5 }).success).toBe(false);
  });

  it('rejects a non-nullable-missing contact object', () => {
    expect(ExtractionResultSchema.safeParse({ ...valid, contact: {} }).success).toBe(false);
  });
});

describe('DraftResultSchema', () => {
  it('parses a valid draft', () => {
    const result = DraftResultSchema.safeParse({
      reply: 'Gerne helfe ich weiter.',
      confidence: 0.8,
      used_source_ids: ['src-1', 'src-2'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-string used_source_ids entry', () => {
    expect(
      DraftResultSchema.safeParse({ reply: 'x', confidence: 0.5, used_source_ids: [1] }).success
    ).toBe(false);
  });
});

describe('KbChunkMatchSchema', () => {
  it('parses a valid RPC row', () => {
    const result = KbChunkMatchSchema.safeParse({
      id: 'chunk-1',
      source_id: 'src-1',
      content: 'Öffnungszeiten: Mo-Fr 9-17 Uhr.',
      similarity: 0.83,
    });
    expect(result.success).toBe(true);
  });
});
