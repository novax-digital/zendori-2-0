// Operator CLI (Phase 9): generates the voice-preview samples for the channel
// settings UI ("Stimme → Anhören"). For each xAI voice it opens a plain
// realtime WebSocket session (NOT call-attached — setting formats is fine
// here), asks the model to speak a fixed German sentence and writes the audio
// as WAV to apps/web/public/voice-samples/<voice>.wav.
//
// Usage (from apps/worker, .env at repo root):
//   npx tsx --env-file=../../.env scripts/generate-voice-samples.ts [--voices eve,ara]
//
// Required env: XAI_API_KEY. Optional: XAI_API_BASE.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const VOICES = ['eve', 'ara', 'rex', 'sal', 'leo'];
const SAMPLE_TEXT =
  'Guten Tag! So klinge ich am Telefon. Ich beantworte Fragen, nehme Anliegen auf und leite sie an Ihr Team weiter.';
const OUT_DIR = path.resolve(process.cwd(), '../web/public/voice-samples');
const SESSION_TIMEOUT_MS = 60_000;
/** Fallback when the session does not echo an output sample rate. */
const DEFAULT_SAMPLE_RATE = 24_000;

function apiBase(): string {
  return (process.env.XAI_API_BASE?.replace(/\/+$/, '') || 'https://api.x.ai').replace(
    /^http/,
    'ws'
  );
}

/** Minimal 16-bit mono PCM → WAV wrapper. */
function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Digs a numeric sample rate out of a session payload (shape variants tolerated). */
function findSampleRate(node: unknown): number | null {
  if (!node || typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (/(sample_)?rate/i.test(key) && typeof value === 'number' && value >= 8000) return value;
    const nested = findSampleRate(value);
    if (nested) return nested;
  }
  return null;
}

async function generateSample(apiKey: string, voice: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${apiBase()}/v1/realtime`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const chunks: Buffer[] = [];
    let sampleRate: number | null = null;
    let settled = false;

    const timer = setTimeout(() => {
      fail(new Error(`timeout after ${SESSION_TIMEOUT_MS}ms`));
    }, SESSION_TIMEOUT_MS);

    function done(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (chunks.length === 0) {
        reject(new Error('no audio received'));
        return;
      }
      const wav = pcm16ToWav(Buffer.concat(chunks), sampleRate ?? DEFAULT_SAMPLE_RATE);
      const file = path.join(OUT_DIR, `${voice}.wav`);
      writeFileSync(file, wav);
      console.log(
        `  ${voice}: ${(wav.length / 1024).toFixed(0)} kB @ ${sampleRate ?? DEFAULT_SAMPLE_RATE} Hz → ${file}`
      );
      resolve();
    }

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      reject(err);
    }

    ws.on('open', () => {
      /* wait for session.created */
    });
    ws.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    ws.on('message', (data) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = String(event.type ?? '');
      if (type === 'session.created') {
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              voice,
              instructions:
                'Du bist eine freundliche deutsche Telefonstimme. Sprich natürlich und klar.',
            },
          })
        );
        return;
      }
      if (type === 'session.updated') {
        sampleRate = sampleRate ?? findSampleRate(event);
        ws.send(
          JSON.stringify({
            type: 'response.create',
            response: { instructions: `Sprich genau diesen Satz, nichts anderes: "${SAMPLE_TEXT}"` },
          })
        );
        return;
      }
      if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
        const delta = event.delta;
        if (typeof delta === 'string' && delta.length > 0) {
          chunks.push(Buffer.from(delta, 'base64'));
        }
        return;
      }
      if (type === 'response.done') {
        done();
        return;
      }
      if (type === 'error') {
        fail(new Error(`server error event: ${JSON.stringify(event.error ?? {}).slice(0, 200)}`));
      }
    });
  });
}

async function main(): Promise<void> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    console.error('Missing env: XAI_API_KEY');
    process.exit(1);
  }
  const flagIndex = process.argv.indexOf('--voices');
  const voices =
    flagIndex >= 0 && process.argv[flagIndex + 1]
      ? process.argv[flagIndex + 1]!.split(',').map((v) => v.trim())
      : VOICES;

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Generating ${voices.length} voice samples → ${OUT_DIR}`);
  for (const voice of voices) {
    try {
      await generateSample(apiKey, voice);
    } catch (err) {
      console.error(`  ${voice}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
