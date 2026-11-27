import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCompanyProfileUserMessage,
  buildLearnUserMessage,
  buildUserMessage,
  plainQuotes,
} from '../src/prompts.js';

// Measured against the real API on 2026-11-26: with an enforced output schema
// the models copy a German quotation — „Wort“ — with a straight closing quote
// they do not escape. That quote ends the JSON string and the rest of the field
// is silently lost (a ticket description of 208 characters came back as 55).
// Two defences, pinned here: customer text is handed over with plain quotes
// (which the models escape correctly), and a field that still ends in an open
// quotation mark is treated as cut.

describe('plainQuotes', () => {
  it('turns typographic double quotation marks into the plain one', () => {
    expect(plainQuotes('Knopf „Hörprobe“ und “Start” sowie „gemischt"')).toBe(
      'Knopf "Hörprobe" und "Start" sowie "gemischt"'
    );
  });

  it('leaves everything else alone', () => {
    const text = 'Geht’s? ‚einfach‘ »Guillemets« 15" Monitor – ok';
    expect(plainQuotes(text)).toBe(text);
  });
});

describe('customer text in the prompts', () => {
  it('reaches classify, extract and draft with plain quotes', () => {
    const message = buildUserMessage({
      channelType: 'email',
      subject: 'Knopf „Hörprobe“ geht nicht',
      body: 'Unter „So meldet sich der Charakter“ ist nur ein leerer Kasten.',
    });
    expect(message).toContain('Betreff: Knopf "Hörprobe" geht nicht');
    expect(message).toContain('Unter "So meldet sich der Charakter" ist nur ein leerer Kasten.');
    expect(message).not.toMatch(/[„“”]/);
  });

  it('reaches the learning step and the company profile with plain quotes', () => {
    expect(buildLearnUserMessage('Wo ist „Start“?', 'Oben rechts bei „Menü“.')).not.toMatch(/[„“”]/);
    expect(buildCompanyProfileUserMessage('Unser Motto: „Sonne für alle“')).not.toMatch(/[„“”]/);
  });
});

// --- the guard on what comes back -----------------------------------------------------

let server: Server;
let queue: unknown[] = [];

function jsonMessage(payload: unknown): unknown {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      const next = queue.shift();
      res.writeHead(next ? 200 : 500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          next ?? { type: 'error', error: { type: 'api_error', message: 'empty queue' } }
        )
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_API_BASE = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  queue = [];
});

const { classify, cutAtOpenQuote, extract, learn } = await import('../src/anthropic.js');

const BODY =
  'Guten Tag, bei jeder Karte steht ein Knopf „Hörprobe“, aber es passiert nichts. Ich nutze Safari auf dem iPad.';
const EXTRACTION = {
  contact: { name: 'Max Muster', email: 'max@example.com', phone: null, company: null },
  subject: 'Hörprobe funktioniert nicht',
  description: 'Bei jeder Karte steht ein Knopf "Hörprobe", aber es passiert nichts. Safari, iPad.',
  category: 'Störung',
  missing_fields: [],
  questions: [],
  confidence: 0.9,
};

describe('cutAtOpenQuote', () => {
  it('knows a field that ends inside a quotation', () => {
    expect(cutAtOpenQuote('Bei jeder Karte steht ein Knopf „Hörprobe')).toBe(true);
    expect(cutAtOpenQuote('Frage zur „')).toBe(true);
  });

  it('accepts a quotation that is closed, however', () => {
    expect(cutAtOpenQuote('Ein Knopf „Hörprobe“ ist da.')).toBe(false);
    expect(cutAtOpenQuote('Ein Knopf „Hörprobe" ist da.')).toBe(false);
    expect(cutAtOpenQuote('Ein Knopf "Hörprobe" ist da.')).toBe(false);
    expect(cutAtOpenQuote('Kein Zitat.')).toBe(false);
    expect(cutAtOpenQuote('')).toBe(false);
  });
});

describe('fields cut at a quotation mark', () => {
  it('extract: a complete result passes untouched', async () => {
    queue = [jsonMessage(EXTRACTION)];
    const { result } = await extract({
      companyName: 'Acme GmbH',
      categories: ['Störung', 'Sonstiges'],
      channelType: 'email',
      body: BODY,
    });
    expect(result).toEqual(EXTRACTION);
  });

  it('extract: a cut description is replaced by the whole message, a cut subject loses its mark', async () => {
    queue = [
      jsonMessage({
        ...EXTRACTION,
        subject: 'Frage zur „Hörprobe',
        description: 'Bei jeder Karte steht ein Knopf „Hörprobe',
      }),
    ];
    const { result } = await extract({
      companyName: 'Acme GmbH',
      categories: ['Störung', 'Sonstiges'],
      channelType: 'email',
      body: `  ${BODY}  `,
    });
    expect(result.description).toBe(
      'Guten Tag, bei jeder Karte steht ein Knopf "Hörprobe", aber es passiert nichts. Ich nutze Safari auf dem iPad.'
    );
    expect(result.subject).toBe('Frage zur Hörprobe');
    // everything else is the model's
    expect(result.contact).toEqual(EXTRACTION.contact);
    expect(result.category).toBe('Störung');
  });

  it('classify: a cut summary and intent lose the dangling mark', async () => {
    queue = [
      jsonMessage({
        language: 'de',
        intent: 'Störung „Hörprobe',
        priority: 'normal',
        wants_human: false,
        is_spam: false,
        is_auto_reply: false,
        is_new_topic: true,
        summary: 'Der Kunde meldet, dass der Knopf „Hörprobe',
      }),
    ];
    const { result } = await classify({ companyName: 'Acme GmbH', channelType: 'email', body: BODY });
    expect(result.intent).toBe('Störung Hörprobe');
    expect(result.summary).toBe('Der Kunde meldet, dass der Knopf Hörprobe');
    expect(result.priority).toBe('normal');
  });

  it('learn: half an answer is not knowledge', async () => {
    queue = [
      jsonMessage({
        worth_learning: true,
        question: 'Kann ich eine Hörprobe anhören?',
        answer: 'Ja. Auf jeder Karte gibt es einen Knopf „Hörprobe',
      }),
    ];
    await expect(
      learn({ companyName: 'Acme GmbH', customerRequest: 'Probe hören?', humanAnswer: 'Ja, über „Hörprobe“.' })
    ).rejects.toThrow('abgeschnitten');

    queue = [
      jsonMessage({
        worth_learning: true,
        question: 'Kann ich eine Hörprobe anhören?',
        answer: 'Ja. Auf jeder Karte gibt es einen Knopf "Hörprobe".',
      }),
    ];
    const ok = await learn({
      companyName: 'Acme GmbH',
      customerRequest: 'Probe hören?',
      humanAnswer: 'Ja, über „Hörprobe“.',
    });
    expect(ok.result.answer).toBe('Ja. Auf jeder Karte gibt es einen Knopf "Hörprobe".');
  });
});
