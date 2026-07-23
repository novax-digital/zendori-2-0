import { describe, expect, it } from 'vitest';
import { finalizeDraftResult, parseDraftResponse } from '../src/anthropic.js';

describe('parseDraftResponse', () => {
  it('parses a clean strict-JSON draft', () => {
    const result = parseDraftResponse(
      '{"reply":"Gerne, hier die Antwort.","confidence":0.82,"used_source_ids":["kb-1"]}'
    );
    expect(result).toEqual({
      reply: 'Gerne, hier die Antwort.',
      confidence: 0.82,
      used_source_ids: ['kb-1'],
    });
  });

  it('extracts JSON wrapped in a markdown code fence', () => {
    const text = '```json\n{"reply":"Hallo","confidence":0.5,"used_source_ids":[]}\n```';
    expect(parseDraftResponse(text)).toEqual({
      reply: 'Hallo',
      confidence: 0.5,
      used_source_ids: [],
    });
  });

  it('extracts a JSON object embedded in surrounding prose', () => {
    const text =
      'Hier ist mein Entwurf: {"reply":"Danke","confidence":0.6,"used_source_ids":["a"]} — fertig.';
    expect(parseDraftResponse(text)).toEqual({
      reply: 'Danke',
      confidence: 0.6,
      used_source_ids: ['a'],
    });
  });

  it('clamps an out-of-range confidence into 0..1', () => {
    expect(parseDraftResponse('{"reply":"x","confidence":2,"used_source_ids":[]}').confidence).toBe(
      1
    );
    expect(
      parseDraftResponse('{"reply":"x","confidence":-3,"used_source_ids":[]}').confidence
    ).toBe(0);
  });

  it('falls back to the whole text with low confidence on invalid JSON', () => {
    const text = 'Es tut mir leid, ich kann das nicht beantworten.';
    expect(parseDraftResponse(text)).toEqual({
      reply: text,
      confidence: 0.3,
      used_source_ids: [],
    });
  });

  it('falls back when JSON is valid but has the wrong shape', () => {
    const text = '{"foo":"bar"}';
    expect(parseDraftResponse(text)).toEqual({
      reply: text,
      confidence: 0.3,
      used_source_ids: [],
    });
  });
});

describe('finalizeDraftResult', () => {
  const ok = { reply: 'Gerne, hier die Antwort.', confidence: 0.8, used_source_ids: ['a'] };

  it('passes results through untouched without truncation', () => {
    expect(finalizeDraftResult(ok, 'end_turn', 'de')).toEqual(ok);
  });

  it('replaces a truncated raw-JSON fallback with a safe apology at confidence 0', () => {
    const truncated = {
      reply: '{"reply": "Sehr geehrte Frau Muster, vielen Dank',
      confidence: 0.3,
      used_source_ids: [] as string[],
    };
    const result = finalizeDraftResult(truncated, 'max_tokens', 'de');
    expect(result.confidence).toBe(0);
    expect(result.used_source_ids).toEqual([]);
    expect(result.reply).not.toContain('{');
    expect(result.reply).toContain('Mitarbeiter');
  });

  it('uses an English fallback for language en', () => {
    const truncated = { reply: '{"reply": "Dear', confidence: 0.3, used_source_ids: [] as string[] };
    expect(finalizeDraftResult(truncated, 'max_tokens', 'en').reply).toContain('team');
  });

  it('clamps confidence to 0.3 when parsed JSON was cut mid-generation', () => {
    const result = finalizeDraftResult(ok, 'max_tokens', 'de');
    expect(result.reply).toBe(ok.reply);
    expect(result.confidence).toBe(0.3);
  });
});
