import { describe, expect, it } from 'vitest';
import { parseDraftResponse } from '../src/anthropic.js';

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
