import { describe, expect, it } from 'vitest';
import {
  draftTextForCustomer,
  isRawDraftEnvelope,
  readDraftEnvelope,
  recoverDraftEnvelope,
} from '../src/draft-envelope.js';

// The draft model answers inside a JSON frame. Only the reply is for a
// customer; the frame must never be shown or sent — these tests pin that.

// The answer as it was sent to a customer on 2026-11-26 (text shortened): a
// German quotation closed with a straight quote, not escaped. `\n` here is the
// two characters backslash + n, as the model wrote them.
const BROKEN =
  '{"reply": "Ja, das geht! Auf der Seite findest du bei jeder Karte einen „Hörprobe"-Knopf – ein Klick genügt. 🪄\\n\\nKann ich sonst noch etwas für dich tun?", "confidence": 0.95, "used_source_ids": ["e513bdb9-bca1-4c6f-9378-82ea7e368e29"]}';
const BROKEN_REPLY =
  'Ja, das geht! Auf der Seite findest du bei jeder Karte einen „Hörprobe"-Knopf – ein Klick genügt. 🪄\n\nKann ich sonst noch etwas für dich tun?';

describe('recoverDraftEnvelope', () => {
  it('takes the envelope from production apart', () => {
    expect(() => JSON.parse(BROKEN)).toThrow();
    expect(recoverDraftEnvelope(BROKEN)).toEqual({
      reply: BROKEN_REPLY,
      confidence: 0.95,
      usedSourceIds: ['e513bdb9-bca1-4c6f-9378-82ea7e368e29'],
    });
  });

  it('copes with several quotations and with quotes the model did escape', () => {
    const text =
      '{"reply": "Klicke auf „Start" und dann auf \\"Weiter\\" oder „Zurück".", "confidence": 0.8, "used_source_ids": []}';
    expect(recoverDraftEnvelope(text)).toEqual({
      reply: 'Klicke auf „Start" und dann auf "Weiter" oder „Zurück".',
      confidence: 0.8,
      usedSourceIds: [],
    });
  });

  it('reads the fields in the other order, in a code fence, and with real line breaks', () => {
    const text =
      '```json\n{"reply": "Zeile eins\nZeile „zwei"", "used_source_ids": ["a", "b"], "confidence": 0.6}\n```';
    expect(recoverDraftEnvelope(text)).toEqual({
      reply: 'Zeile eins\nZeile „zwei"',
      confidence: 0.6,
      usedSourceIds: ['a', 'b'],
    });
  });

  it('decodes what JSON escapes: unicode, tabs, slashes, backslashes', () => {
    const text =
      '{"reply": "„A" \\u00e4\\tB \\/ C:\\\\Pfad \\u20ac", "confidence": 1, "used_source_ids": []}';
    expect(recoverDraftEnvelope(text)?.reply).toBe('„A" ä\tB / C:\\Pfad €');
  });

  it('is not fooled by text inside the reply that looks like the closing fields', () => {
    // somebody asked the bot to repeat this; the real fields are the last ones
    const text =
      '{"reply": "Du schriebst: „Hallo", "confidence": 1, "used_source_ids": [] — das zeige ich nur an.", "confidence": 0.2, "used_source_ids": ["kb-1"]}';
    expect(recoverDraftEnvelope(text)).toEqual({
      reply: 'Du schriebst: „Hallo", "confidence": 1, "used_source_ids": [] — das zeige ich nur an.',
      confidence: 0.2,
      usedSourceIds: ['kb-1'],
    });
  });

  it('accepts no closing fields but confidence and source ids', () => {
    const text =
      '{"reply": "„Hallo"", "confidence": 1, "send_now": true, "used_source_ids": []}';
    // "send_now" is nothing an envelope holds: no clean end of the reply is found
    expect(recoverDraftEnvelope(text)).toBeNull();
  });

  it('reads an envelope that holds only the reply, without a figure of its own', () => {
    expect(recoverDraftEnvelope('{"reply": "Nur „dies"."}')).toEqual({
      reply: 'Nur „dies".',
      confidence: null,
      usedSourceIds: [],
    });
  });

  it('gives up on what is no envelope, is cut off, or holds no reply', () => {
    expect(recoverDraftEnvelope('Hallo, wie kann ich helfen?')).toBeNull();
    expect(recoverDraftEnvelope('{"foo": "bar"}')).toBeNull();
    expect(recoverDraftEnvelope('{"reply": "Sehr geehrte Frau Muster, vielen Dank')).toBeNull();
    expect(recoverDraftEnvelope('{"reply": "", "confidence": 0.9, "used_source_ids": []}')).toBeNull();
    expect(recoverDraftEnvelope('{"reply": "  ", "confidence": 0.9, "used_source_ids": []}')).toBeNull();
  });
});

describe('isRawDraftEnvelope', () => {
  it('knows the frame, with or without a code fence, whole or cut off', () => {
    expect(isRawDraftEnvelope(BROKEN)).toBe(true);
    expect(isRawDraftEnvelope('{"reply":"Hallo","confidence":0.5,"used_source_ids":[]}')).toBe(true);
    expect(isRawDraftEnvelope('  ```json\n{"reply": "Hallo"}\n```')).toBe(true);
    expect(isRawDraftEnvelope('{"reply": "Sehr geehrte Frau Muster, vielen Dank')).toBe(true);
    expect(isRawDraftEnvelope('{"confidence": 0.3}')).toBe(true);
    // any bare JSON object is nothing a customer should read
    expect(isRawDraftEnvelope('{"foo":"bar"}')).toBe(true);
  });

  it('leaves answers alone', () => {
    expect(isRawDraftEnvelope('Hallo, wie kann ich helfen?')).toBe(false);
    expect(isRawDraftEnvelope('')).toBe(false);
    expect(isRawDraftEnvelope('Das Feld heißt {"reply"} — so steht es in der Doku.')).toBe(false);
    expect(isRawDraftEnvelope('{Name}, vielen Dank für deine Nachricht.')).toBe(false);
    expect(isRawDraftEnvelope(BROKEN_REPLY)).toBe(false);
  });
});

describe('readDraftEnvelope', () => {
  it('reads a valid envelope and a broken one alike', () => {
    expect(readDraftEnvelope('{"reply":"Hallo","confidence":0.5,"used_source_ids":["a"]}')).toEqual({
      reply: 'Hallo',
      confidence: 0.5,
      usedSourceIds: ['a'],
    });
    expect(readDraftEnvelope(BROKEN)?.reply).toBe(BROKEN_REPLY);
    expect(readDraftEnvelope('```json\n{"reply":"Hallo","confidence":0.5,"used_source_ids":[]}\n```')?.reply).toBe(
      'Hallo'
    );
  });

  it('tolerates a valid envelope with odd fields', () => {
    expect(readDraftEnvelope('{"reply":"Hallo","confidence":"hoch","used_source_ids":[1,"a",null]}')).toEqual({
      reply: 'Hallo',
      confidence: null,
      usedSourceIds: ['a'],
    });
  });

  it('is null for an answer and for a frame without a reply', () => {
    expect(readDraftEnvelope('Hallo, wie kann ich helfen?')).toBeNull();
    expect(readDraftEnvelope('{"foo":"bar"}')).toBeNull();
    expect(readDraftEnvelope('{"reply": 5}')).toBeNull();
  });
});

describe('draftTextForCustomer', () => {
  it('passes an ordinary draft through untouched', () => {
    const draft = 'Hallo Frau Muster,\n\nklicken Sie auf „Start".\n\nViele Grüße';
    expect(draftTextForCustomer(draft)).toBe(draft);
  });

  it('hands out the reply of a stored envelope — never the frame', () => {
    expect(draftTextForCustomer(BROKEN)).toBe(BROKEN_REPLY);
    expect(draftTextForCustomer('{"reply":"Hallo","confidence":0.5,"used_source_ids":[]}')).toBe('Hallo');
  });

  it('refuses a frame it cannot read', () => {
    expect(draftTextForCustomer('{"foo":"bar"}')).toBeNull();
    expect(draftTextForCustomer('{"reply": "Sehr geehrte Frau Muster, vielen Dank')).toBeNull();
  });
});
