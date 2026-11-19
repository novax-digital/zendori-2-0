import WebSocket from 'ws';
import type { DemoTranscriptTurn, Logger, SupabaseClient } from '@zendori/core';
import { toErrorInfo } from '../db.js';
import {
  callWebSocketUrl,
  forceMessageEvent,
  functionCallArgsDoneSchema,
  functionCallOutputEvent,
  hangupCall,
  outputTextDeltaSchema,
  outputTranscriptDeltaSchema,
  responseCreateEvent,
  serverEventSchema,
  sessionUpdateEvent,
  transcriptionCompletedSchema,
  transcriptionUpdatedSchema,
  type SessionConfig,
} from '../voice/xai-realtime.js';
import { DEMO_FAREWELL_TEXT, DEMO_TIMEOUT_TEXT } from './prompt.js';

// Demo-Anruf (0032): one lean session per live demo call. Same xAI protocol
// rules as the Phase-9 CallSession (wait for session.created; greeting via
// force_message and response.create only after ITS response.done; playback
// grace before hangup; serialized event handling; OPEN-guarded pings) — but no
// conversations/messages/tickets/tools beyond end_call: the transcript goes
// into demo_calls.transcript, nothing touches a tenant org. Never logs
// transcript content (§7).

const PING_INTERVAL_MS = 15_000;
const SETUP_TIMEOUT_MS = 15_000;
/** Buffer before the hard hangup after the timeout notice. */
const TIMEOUT_NOTICE_MS = 7_000;
const DRAIN_FAREWELL_MS = 4_000;
const DRAIN_MAX_WAIT_MS = 10_000;

/** ~14 chars/s German speech + carrier buffering (live 2026-07-21 cutoff lesson). */
export function playbackMs(chars: number, minMs = 3_000, maxMs = 12_000): number {
  return Math.min(maxMs, Math.max(minMs, chars * 70 + 1_200));
}

type SessionState = 'connecting' | 'configuring' | 'active' | 'ending' | 'closed';

export interface DemoCallSessionParams {
  supabase: SupabaseClient;
  logger: Logger;
  apiKey: string;
  demoCallId: string;
  providerCallId: string;
  sessionConfig: SessionConfig;
  /** Opening line spoken verbatim (AI disclosure). */
  greeting: string;
  maxCallSeconds: number;
  /** Called exactly once when the session is closed (registry cleanup). */
  onClosed: (demoCallId: string) => void;
  /** Test seams. */
  wsUrl?: string;
  hangupGraceMs?: number;
  greetFallbackMs?: number;
}

export class DemoCallSession {
  private readonly p: DemoCallSessionParams;
  private ws: WebSocket | null = null;
  private state: SessionState = 'connecting';
  private startedAtMs: number | null = null;
  private endedReason: string | null = null;
  private closedNotified = false;

  private readonly turns: DemoTranscriptTurn[] = [];
  /** Latest cumulative caller transcript per item (xAI: cumulative, not appended). */
  private readonly callerText = new Map<string, string>();
  /** item_id → index into turns once flushed (late ASR corrections update in place). */
  private readonly flushedIndex = new Map<string, number>();
  private botBuffer = '';
  private sawAudioDelta = false;
  private pendingToolCalls: { callId: string; name: string }[] = [];
  /** The greeting force_message is playing; the first model turn follows its response.done. */
  private greetPending = false;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private greetFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private hangupTimer: ReturnType<typeof setTimeout> | null = null;
  private processing: Promise<void> = Promise.resolve();
  private closedResolve: (() => void) | null = null;
  readonly closed: Promise<void>;

  constructor(params: DemoCallSessionParams) {
    this.p = params;
    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
  }

  start(): void {
    const ws = new WebSocket(this.p.wsUrl ?? callWebSocketUrl(this.p.providerCallId), {
      headers: { Authorization: `Bearer ${this.p.apiKey}` },
    });
    this.ws = ws;
    this.setupTimer = setTimeout(() => {
      if (this.state === 'connecting' || this.state === 'configuring') {
        this.p.logger.warn({ demoCallId: this.p.demoCallId }, 'demo session setup timeout');
        ws.terminate();
      }
    }, SETUP_TIMEOUT_MS);
    ws.on('message', (data) => {
      const raw = String(data);
      this.processing = this.processing.then(() => this.onMessage(raw));
    });
    ws.on('error', (err) => {
      this.p.logger.warn({ demoCallId: this.p.demoCallId, err: toErrorInfo(err) }, 'demo ws error');
    });
    ws.on('close', (code) => {
      this.processing = this.processing.then(() => this.onClose(code));
    });
  }

  /** Test seam / registry: current transcript snapshot. */
  transcript(): DemoTranscriptTurn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  // --- protocol ---------------------------------------------------------------------

  private async onMessage(raw: string): Promise<void> {
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const peek = serverEventSchema.safeParse(event);
    if (!peek.success) return;
    const type = peek.data.type;
    try {
      switch (true) {
        case type === 'session.created':
          if (this.state === 'connecting') {
            this.state = 'configuring';
            this.send(sessionUpdateEvent(this.p.sessionConfig));
          }
          break;
        case type === 'session.updated':
          await this.onSessionUpdated();
          break;
        case type === 'conversation.item.input_audio_transcription.updated': {
          const parsed = transcriptionUpdatedSchema.safeParse(event);
          if (parsed.success) this.callerText.set(parsed.data.item_id, parsed.data.transcript);
          break;
        }
        case type === 'conversation.item.input_audio_transcription.completed': {
          const parsed = transcriptionCompletedSchema.safeParse(event);
          if (parsed.success) {
            this.callerText.set(parsed.data.item_id, parsed.data.transcript);
            this.flushCaller(parsed.data.item_id);
          }
          break;
        }
        case type === 'response.created':
          this.botBuffer = '';
          this.sawAudioDelta = false;
          this.pendingToolCalls = [];
          for (const itemId of this.callerText.keys()) this.flushCaller(itemId);
          break;
        case type === 'response.audio_transcript.delta' ||
          type === 'response.output_audio_transcript.delta': {
          const parsed = outputTranscriptDeltaSchema.safeParse(event);
          if (parsed.success) {
            if (!this.sawAudioDelta) this.botBuffer = '';
            this.sawAudioDelta = true;
            this.botBuffer += parsed.data.delta;
          }
          break;
        }
        case type === 'response.text.delta' || type === 'response.output_text.delta': {
          if (!this.sawAudioDelta) {
            const parsed = outputTextDeltaSchema.safeParse(event);
            if (parsed.success) this.botBuffer += parsed.data.delta;
          }
          break;
        }
        case type === 'response.function_call_arguments.done': {
          const parsed = functionCallArgsDoneSchema.safeParse(event);
          if (parsed.success) {
            this.pendingToolCalls.push({ callId: parsed.data.call_id, name: parsed.data.name });
          }
          break;
        }
        case type === 'response.done':
          await this.onResponseDone();
          break;
        case type === 'error':
          this.p.logger.warn({ demoCallId: this.p.demoCallId }, 'demo ws error event');
          break;
        default:
          break;
      }
    } catch (err) {
      this.p.logger.error(
        { demoCallId: this.p.demoCallId, eventType: type, err: toErrorInfo(err) },
        'demo event handling failed'
      );
    }
  }

  private async onSessionUpdated(): Promise<void> {
    if (this.state !== 'configuring') return;
    this.state = 'active';
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.startedAtMs = Date.now();
    await this.p.supabase
      .from('demo_calls')
      .update({ status: 'in_call', started_at: new Date().toISOString() })
      .eq('id', this.p.demoCallId)
      .eq('status', 'connecting');

    this.maxDurationTimer = setTimeout(() => {
      void this.endByWatchdog();
    }, this.p.maxCallSeconds * 1000);
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
    }, PING_INTERVAL_MS);

    // AI disclosure first, verbatim and not interruptible. The model's first
    // turn is requested only on the greeting's response.done — a
    // response.create sent while the force_message plays gets dropped.
    this.send(forceMessageEvent(this.p.greeting, false));
    this.greetPending = true;
    this.greetFallbackTimer = setTimeout(
      () => this.fireFirstTurn(),
      this.p.greetFallbackMs ?? playbackMs(this.p.greeting.length, 4_000, 12_000)
    );
  }

  private fireFirstTurn(): void {
    if (!this.greetPending) return;
    this.greetPending = false;
    if (this.greetFallbackTimer) {
      clearTimeout(this.greetFallbackTimer);
      this.greetFallbackTimer = null;
    }
    if (this.state === 'active') this.send(responseCreateEvent());
  }

  private async onResponseDone(): Promise<void> {
    const lastTurnChars = this.botBuffer.trim().length;
    if (lastTurnChars > 0) {
      this.turns.push({ role: 'assistant', text: this.botBuffer.trim(), at: new Date().toISOString() });
      this.botBuffer = '';
      this.sawAudioDelta = false;
    }
    await this.persistTranscript();

    if (this.greetPending) {
      this.fireFirstTurn();
      if (this.pendingToolCalls.length === 0) return;
    }
    if (this.pendingToolCalls.length === 0 || this.state !== 'active') return;

    const calls = this.pendingToolCalls;
    this.pendingToolCalls = [];
    const endRequested = calls.some((c) => c.name === 'end_call');
    for (const call of calls) {
      this.send(
        functionCallOutputEvent(
          call.callId,
          call.name === 'end_call' ? { ok: true } : { ok: false, error: 'unknown tool' }
        )
      );
    }
    if (!endRequested) {
      this.send(responseCreateEvent());
      return;
    }

    this.state = 'ending';
    this.endedReason = 'agent_end';
    this.send(forceMessageEvent(DEMO_FAREWELL_TEXT));
    const graceMs =
      this.p.hangupGraceMs ?? playbackMs(lastTurnChars + DEMO_FAREWELL_TEXT.length);
    this.hangupTimer = setTimeout(() => {
      void hangupCall(this.p.apiKey, this.p.providerCallId).catch((err: unknown) => {
        this.p.logger.warn({ demoCallId: this.p.demoCallId, err: toErrorInfo(err) }, 'demo hangup failed');
        this.ws?.close();
      });
    }, graceMs);
  }

  // --- transcript -------------------------------------------------------------------

  private flushCaller(itemId: string): void {
    const text = this.callerText.get(itemId)?.trim();
    if (!text) return;
    const index = this.flushedIndex.get(itemId);
    if (index !== undefined) {
      const turn = this.turns[index];
      if (turn) turn.text = text; // late, final ASR text corrects the flushed turn
      return;
    }
    this.flushedIndex.set(itemId, this.turns.length);
    this.turns.push({ role: 'caller', text, at: new Date().toISOString() });
  }

  private async persistTranscript(): Promise<void> {
    const { error } = await this.p.supabase
      .from('demo_calls')
      .update({ transcript: this.turns })
      .eq('id', this.p.demoCallId);
    if (error) {
      this.p.logger.warn({ demoCallId: this.p.demoCallId, code: error.code }, 'demo transcript persist failed');
    }
  }

  // --- end paths -------------------------------------------------------------------

  private async endByWatchdog(): Promise<void> {
    if (this.state !== 'active') return;
    this.state = 'ending';
    this.endedReason = 'max_duration';
    this.send(forceMessageEvent(DEMO_TIMEOUT_TEXT));
    this.hangupTimer = setTimeout(() => {
      void hangupCall(this.p.apiKey, this.p.providerCallId).catch(() => this.ws?.close());
    }, this.p.hangupGraceMs ?? TIMEOUT_NOTICE_MS);
  }

  /** Worker shutdown: short notice + hangup, then wait (bounded) for finalize. */
  async drain(): Promise<void> {
    if (this.state === 'closed') return;
    if (this.state === 'active') {
      this.state = 'ending';
      this.endedReason = 'worker_shutdown';
      this.send(forceMessageEvent(DEMO_TIMEOUT_TEXT));
      await new Promise((r) => setTimeout(r, DRAIN_FAREWELL_MS));
      try {
        await hangupCall(this.p.apiKey, this.p.providerCallId);
      } catch {
        this.ws?.terminate();
      }
    } else {
      this.endedReason = this.endedReason ?? 'worker_shutdown';
      this.ws?.terminate();
      await this.finalize(this.startedAtMs !== null ? 'completed' : 'failed', this.endedReason);
    }
    await Promise.race([this.closed, new Promise((r) => setTimeout(r, DRAIN_MAX_WAIT_MS))]);
  }

  private async onClose(code?: number): Promise<void> {
    if (this.state === 'closed') return;
    this.p.logger.info(
      { demoCallId: this.p.demoCallId, closeCode: code ?? null, state: this.state },
      'demo ws closed'
    );
    if (this.startedAtMs === null) {
      await this.finalize('failed', this.endedReason ?? 'connect_failed');
      return;
    }
    // xAI closes abnormally when the callee hangs up (Phase-9 live evidence) —
    // a demo has no rejoin: any close after the active phase ends the call. A
    // best-effort hangup covers a worker-side drop while the call is alive.
    if (this.state !== 'ending') {
      void hangupCall(this.p.apiKey, this.p.providerCallId).catch(() => undefined);
    }
    await this.finalize('completed', this.endedReason ?? 'remote_close');
  }

  private async finalize(status: 'completed' | 'failed', reason: string): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const timer of [this.setupTimer, this.maxDurationTimer, this.greetFallbackTimer, this.hangupTimer]) {
      if (timer) clearTimeout(timer);
    }
    if (this.pingTimer) clearInterval(this.pingTimer);

    for (const itemId of this.callerText.keys()) this.flushCaller(itemId);
    if (this.botBuffer.trim().length > 0) {
      this.turns.push({ role: 'assistant', text: this.botBuffer.trim(), at: new Date().toISOString() });
      this.botBuffer = '';
    }
    const durationSeconds = this.startedAtMs
      ? Math.round((Date.now() - this.startedAtMs) / 1000)
      : null;
    const { error } = await this.p.supabase
      .from('demo_calls')
      .update({
        status,
        status_detail: reason,
        ended_at: new Date().toISOString(),
        duration_seconds: durationSeconds,
        transcript: this.turns,
      })
      .eq('id', this.p.demoCallId)
      .in('status', ['connecting', 'in_call']);
    if (error) {
      this.p.logger.error({ demoCallId: this.p.demoCallId, code: error.code }, 'demo finalize failed');
    }
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    if (!this.closedNotified) {
      this.closedNotified = true;
      this.p.onClosed(this.p.demoCallId);
    }
    this.closedResolve?.();
  }

  private send(frame: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
  }
}
