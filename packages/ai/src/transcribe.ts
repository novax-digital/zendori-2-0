// OpenAI Whisper transcription via fetch (same no-SDK pattern as embeddings).
// Used by the worker to turn inbound voice notes (WhatsApp ogg/opus, mp3, amr)
// into text so the normal classify/draft pipeline can process them. The
// transcript is message content — persisted in RLS-protected rows, never
// logged (§7).

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const TRANSCRIBE_MODEL = 'whisper-1';
/** USD per minute of audio (OpenAI Whisper pricing). */
const WHISPER_USD_PER_MINUTE = 0.006;
/** Voice notes are short — cap what we ever send (attachments can be 16MB+). */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

export interface TranscribeInput {
  audio: Uint8Array;
  /** Filename with a real extension — Whisper sniffs the container from it. */
  filename: string;
  mime: string;
}

export interface TranscribeResult {
  text: string;
  /** Audio duration in seconds as reported by the API (0 when absent). */
  durationSeconds: number;
  costUsd: number;
}

export async function transcribeAudio(input: TranscribeInput): Promise<TranscribeResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY ist nicht gesetzt.');
  const baseUrl = (process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  if (input.audio.byteLength === 0) throw new Error('Leere Audiodatei.');
  if (input.audio.byteLength > MAX_TRANSCRIBE_BYTES) {
    throw new Error('Audiodatei ist zu groß für die Transkription.');
  }

  const form = new FormData();
  form.append('model', TRANSCRIBE_MODEL);
  // verbose_json carries the duration → real cost accounting in ai_runs
  form.append('response_format', 'verbose_json');
  // Copy into a plain ArrayBuffer-backed view — satisfies the DOM lib's
  // BlobPart without the (Node-absent) BlobPart type name.
  const bytes = new Uint8Array(input.audio);
  form.append(
    'file',
    new Blob([bytes.buffer], { type: input.mime || 'application/octet-stream' }),
    input.filename
  );

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Transkription fehlgeschlagen (HTTP ${response.status}).`);
  }
  const payload = (await response.json()) as { text?: string; duration?: number };
  const text = (payload.text ?? '').trim();
  const durationSeconds =
    typeof payload.duration === 'number' && payload.duration > 0 ? payload.duration : 0;
  return {
    text,
    durationSeconds,
    costUsd: (durationSeconds / 60) * WHISPER_USD_PER_MINUTE,
  };
}
