import { z } from 'zod';

// xAI realtime WebSocket protocol (OpenAI-Realtime-compatible with documented
// deltas). Server events are zod-parsed at the boundary; client events are
// built through typed helpers. The receive side accepts BOTH the beta and GA
// event-name variants (which one xAI emits live is a verify point) and
// normalizes internally. No `any` at the boundary (§8.4).

// --- server events -------------------------------------------------------------

export const serverEventSchema = z.object({ type: z.string() }).passthrough();
export type ServerEvent = z.infer<typeof serverEventSchema>;

export const sessionCreatedSchema = z.object({
  type: z.literal('session.created'),
  session: z.record(z.string(), z.unknown()).optional(),
});

/**
 * xAI delta vs OpenAI: the user-speech transcript event is renamed to
 * `...updated` and its `transcript` is CUMULATIVE (full text so far), not an
 * appended fragment. Keep only the latest value per item_id.
 */
export const transcriptionUpdatedSchema = z.object({
  type: z.literal('conversation.item.input_audio_transcription.updated'),
  item_id: z.string(),
  transcript: z.string(),
});

/** OpenAI-compatible completed event (in case xAI emits it too). */
export const transcriptionCompletedSchema = z.object({
  type: z.literal('conversation.item.input_audio_transcription.completed'),
  item_id: z.string(),
  transcript: z.string(),
});

/** Assistant transcript deltas — both beta and GA names. */
export const outputTranscriptDeltaSchema = z.object({
  type: z.enum(['response.audio_transcript.delta', 'response.output_audio_transcript.delta']),
  response_id: z.string().optional(),
  delta: z.string(),
});

export const outputTextDeltaSchema = z.object({
  type: z.enum(['response.text.delta', 'response.output_text.delta']),
  response_id: z.string().optional(),
  delta: z.string(),
});

export const functionCallArgsDoneSchema = z.object({
  type: z.literal('response.function_call_arguments.done'),
  call_id: z.string(),
  name: z.string(),
  /** JSON-encoded arguments string — JSON.parse + zod-validate per tool. */
  arguments: z.string(),
});

export const responseDoneSchema = z.object({
  type: z.literal('response.done'),
  response: z.record(z.string(), z.unknown()).optional(),
});

export const dtmfEventSchema = z.object({
  type: z.literal('input_audio_buffer.dtmf_event_received'),
  event: z.string(),
});

export const errorEventSchema = z.object({
  type: z.literal('error'),
  error: z.record(z.string(), z.unknown()).optional(),
});

// --- client events ---------------------------------------------------------------

export interface SessionConfig {
  instructions: string;
  voice: string;
  reasoning?: { effort: 'high' | 'none' };
  turn_detection: {
    type: 'server_vad';
    idle_timeout_ms?: number;
  };
  audio: {
    input: {
      format: { type: 'audio/pcmu'; rate: 8000 };
      transcription: { language_hint: string; keyterms?: string[] };
    };
    output: {
      format: { type: 'audio/pcmu'; rate: 8000 };
      speed?: number;
    };
  };
  tools: FunctionTool[];
  resumption?: { enabled: boolean };
}

export interface FunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function sessionUpdateEvent(session: SessionConfig): string {
  return JSON.stringify({ type: 'session.update', session });
}

export function responseCreateEvent(instructions?: string): string {
  return JSON.stringify(
    instructions
      ? { type: 'response.create', response: { instructions } }
      : { type: 'response.create' }
  );
}

export function functionCallOutputEvent(callId: string, output: unknown): string {
  return JSON.stringify({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
  });
}

/**
 * xAI extension: speak a text verbatim. The force_message IS the turn — do NOT
 * send response.create afterwards.
 */
export function forceMessageEvent(text: string, interruptible = false): string {
  return JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'force_message',
      role: 'assistant',
      interruptible,
      content: [{ type: 'output_text', text }],
    },
  });
}

// --- REST call control -------------------------------------------------------------

const API_BASE_DEFAULT = 'https://api.x.ai';

function apiBase(): string {
  const configured = process.env.XAI_API_BASE?.trim();
  return configured && configured.length > 0 ? configured.replace(/\/+$/, '') : API_BASE_DEFAULT;
}

/** WebSocket URL to join an inbound SIP call. */
export function callWebSocketUrl(callId: string): string {
  const base = apiBase().replace(/^http/, 'ws');
  return `${base}/v1/realtime?call_id=${encodeURIComponent(callId)}`;
}

async function callControl(path: string, apiKey: string, body?: unknown): Promise<void> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(`xai call control ${path} returned status ${res.status}`);
  }
}

/** Transfer the caller to a PSTN/SIP target (live handoff, §6). */
export async function referCall(apiKey: string, callId: string, targetUri: string): Promise<void> {
  await callControl(`/v1/realtime/calls/${encodeURIComponent(callId)}/refer`, apiKey, {
    target_uri: targetUri,
  });
}

/** End the call. */
export async function hangupCall(apiKey: string, callId: string): Promise<void> {
  await callControl(`/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, apiKey);
}
