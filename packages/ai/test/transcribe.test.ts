import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transcribeAudio, MAX_TRANSCRIBE_BYTES } from '../src/transcribe.js';

const realFetch = globalThis.fetch;

describe('transcribeAudio', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  });

  it('sends multipart to /audio/transcriptions and returns trimmed text + duration cost', async () => {
    let capturedUrl = '';
    let capturedBody: FormData | null = null;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = init?.body as FormData;
      return new Response(JSON.stringify({ text: '  Hallo, ich habe eine Frage.  ', duration: 30 }), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await transcribeAudio({
      audio: new Uint8Array([1, 2, 3]),
      filename: 'note.ogg',
      mime: 'audio/ogg',
    });

    expect(capturedUrl).toContain('/audio/transcriptions');
    expect(capturedBody?.get('model')).toBe('whisper-1');
    expect(capturedBody?.get('response_format')).toBe('verbose_json');
    expect(result.text).toBe('Hallo, ich habe eine Frage.');
    expect(result.durationSeconds).toBe(30);
    // 30s = 0.5min × $0.006
    expect(result.costUsd).toBeCloseTo(0.003, 6);
  });

  it('throws on a non-2xx response (pg-boss retries)', async () => {
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    await expect(
      transcribeAudio({ audio: new Uint8Array([1]), filename: 'a.ogg', mime: 'audio/ogg' })
    ).rejects.toThrow('429');
  });

  it('rejects empty and oversized audio without calling the API', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(
      transcribeAudio({ audio: new Uint8Array(0), filename: 'a.ogg', mime: 'audio/ogg' })
    ).rejects.toThrow();
    await expect(
      transcribeAudio({
        audio: new Uint8Array(MAX_TRANSCRIBE_BYTES + 1),
        filename: 'a.ogg',
        mime: 'audio/ogg',
      })
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
