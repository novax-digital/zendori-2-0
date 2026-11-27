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

  // Sent to a customer as it stood on 2026-11-26: the model closed a German
  // quotation with a straight quote and did not escape it. `\\n` is the two
  // characters backslash + n, as the model wrote them.
  const BROKEN =
    '{"reply": "Auf der Seite findest du einen „Hörprobe"-Knopf. 🪄\\n\\nKann ich sonst noch etwas tun?", "confidence": 0.95, "used_source_ids": ["e513bdb9-bca1-4c6f-9378-82ea7e368e29"]}';

  it('takes an envelope apart that a quotation mark has broken', () => {
    expect(() => JSON.parse(BROKEN)).toThrow();
    expect(parseDraftResponse(BROKEN)).toEqual({
      reply: 'Auf der Seite findest du einen „Hörprobe"-Knopf. 🪄\n\nKann ich sonst noch etwas tun?',
      // the model's own figure — the answer is as good as in a valid envelope
      confidence: 0.95,
      used_source_ids: ['e513bdb9-bca1-4c6f-9378-82ea7e368e29'],
    });
  });

  it('keeps a recovered envelope without a figure below every threshold', () => {
    expect(parseDraftResponse('{"reply": "Nur „dies"."}')).toEqual({
      reply: 'Nur „dies".',
      confidence: 0.3,
      used_source_ids: [],
    });
    // out of range is clamped, as for a valid envelope
    expect(
      parseDraftResponse('{"reply": "„x"", "confidence": 7, "used_source_ids": []}').confidence
    ).toBe(1);
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

  it('never lets the raw JSON frame pass, whatever the stop reason', () => {
    const frames = [
      // an envelope nobody could take apart
      '{"reply": "„Hallo"", "confidence": 1, "send_now": true, "used_source_ids": []}',
      // valid JSON of the wrong shape
      '{"foo":"bar"}',
      '```json\n{"reply": 5}\n```',
    ];
    for (const frame of frames) {
      for (const stop of ['end_turn', 'stop_sequence', 'max_tokens', null]) {
        const result = finalizeDraftResult(parseDraftResponse(frame), stop, 'de');
        expect(result.reply).not.toContain('{');
        expect(result.reply).toContain('Mitarbeiter');
        // confidence 0: below every threshold, so it can never auto-send
        expect(result.confidence).toBe(0);
        expect(result.used_source_ids).toEqual([]);
      }
    }
  });

  it('leaves a recovered envelope and ordinary prose alone', () => {
    const recovered = parseDraftResponse(
      '{"reply": "Klicke auf „Start".", "confidence": 0.9, "used_source_ids": ["a"]}'
    );
    expect(finalizeDraftResult(recovered, 'end_turn', 'de')).toEqual({
      reply: 'Klicke auf „Start".',
      confidence: 0.9,
      used_source_ids: ['a'],
    });
    const prose = parseDraftResponse('Es tut mir leid, das kann ich nicht beantworten.');
    expect(finalizeDraftResult(prose, 'end_turn', 'de')).toEqual(prose);
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
