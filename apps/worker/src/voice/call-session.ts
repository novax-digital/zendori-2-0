import WebSocket from 'ws';
import type { Logger, SupabaseClient } from '@zendori/core';
import type { VoiceChannelConfig } from '@zendori/channels';
import { toErrorInfo } from '../db.js';
import {
  buildSessionConfig,
  type SessionContext,
  type VoiceAgentBehavior,
} from './session-config.js';
import {
  callWebSocketUrl,
  forceMessageEvent,
  functionCallArgsDoneSchema,
  functionCallOutputEvent,
  hangupCall,
  outputTextDeltaSchema,
  outputTranscriptDeltaSchema,
  referCall,
  responseCreateEvent,
  serverEventSchema,
  sessionUpdateEvent,
  transcriptionCompletedSchema,
  transcriptionUpdatedSchema,
} from './xai-realtime.js';
import { createTicketTool, handoffTool, kbSearchTool, type ToolContext } from './tools.js';
import { startCallRecording, type TwilioRecordingCreds } from './recording.js';

// One CallSession per live call: holds the outbound WebSocket to xAI for the
// duration of the conversation, persists transcript turns as normal `messages`
// rows (the inbox streams them via the existing realtime UI), executes the
// function tools with the bound org_id, and finalizes the voice_calls row on
// every exit path. Never logs transcript content or audio (§7) — only ids,
// event types and error shapes.

const TRANSFER_HOLD_TEXT = 'Einen Moment bitte, ich verbinde Sie mit einem Mitarbeiter.';
/** Mandatory §201-StGB consent notice — spoken verbatim BEFORE the greeting. */
const RECORDING_NOTICE_TEXT =
  'Dieses Gespräch wird zur Qualitätssicherung aufgezeichnet.';
const GOODBYE_TIMEOUT_TEXT =
  'Wir müssen das Gespräch aus technischen Gründen beenden. Wir rufen Sie schnellstmöglich zurück. Auf Wiederhören.';
const PING_INTERVAL_MS = 15_000;
/** Covers connecting AND configuring — a session must reach 'active' within this. */
const SETUP_TIMEOUT_MS = 15_000;
const DRAIN_FAREWELL_MS = 4_000;
const DRAIN_MAX_WAIT_MS = 10_000;

type SessionState = 'connecting' | 'configuring' | 'active' | 'ending' | 'closed';

export interface CallSessionParams {
  supabase: SupabaseClient;
  logger: Logger;
  apiKey: string;
  voiceCallId: string;
  providerCallId: string;
  orgId: string;
  channelId: string;
  conversationId: string;
  channelConfig: VoiceChannelConfig;
  /** Assigned agent's behavior (0011), resolved by dispatch. */
  agent: VoiceAgentBehavior;
  context: SessionContext;
  /**
   * Present only when the channel has recordingEnabled AND the operator Twilio
   * creds are configured AND the webhook captured the Twilio CallSid. The
   * session then speaks the consent notice before the greeting and starts a
   * dual-channel recording (best-effort — a failure never kills the call).
   */
  recording?: { creds: TwilioRecordingCreds; twilioCallSid: string } | null;
  /** Called exactly once when the session reaches `closed` (registry cleanup). */
  onClosed: (providerCallId: string) => void;
  /** Test seam: overrides the WS URL (mock server). */
  wsUrl?: string;
}

export class CallSession {
  private readonly p: CallSessionParams;
  private ws: WebSocket | null = null;
  private state: SessionState = 'connecting';
  private startedAtMs: number | null = null;
  /** Latest cumulative transcript per user item_id (xAI delta: cumulative!). */
  private readonly userTranscripts = new Map<string, string>();
  /** Persisted user turns: item_id → { messageId, content } (for late corrections). */
  private readonly flushedItems = new Map<string, { messageId: string | null; content: string }>();
  /** Assistant transcript accumulator for the in-flight response. */
  private botBuffer = '';
  /** True once an audio-transcript delta arrived for the current response. */
  private sawAudioDelta = false;
  /** Tool calls collected for the current response (flushed on response.done). */
  private pendingToolCalls: { callId: string; name: string; rawArguments: string }[] = [];
  /**
   * Set when the §201 recording notice was spoken and the greeting must follow.
   * The greeting response.create is deferred until the notice's response.done —
   * sending it while the force_message turn is still active gets it dropped,
   * leaving dead air until the caller speaks.
   */
  private greetPending = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempted = false;
  private endedReason: string | null = null;
  private closedNotified = false;
  /** Serializes event handling — a handler that awaits must finish before the next event runs. */
  private processing: Promise<void> = Promise.resolve();
  /** Resolved exactly once when finalize completes (drain/tests wait on it). */
  private closedResolve: (() => void) | null = null;
  readonly closed: Promise<void>;

  constructor(params: CallSessionParams) {
    this.p = params;
    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
  }

  /** Opens the WebSocket and drives the session. */
  start(): void {
    this.connect();
  }

  private connect(): void {
    const url = this.p.wsUrl ?? callWebSocketUrl(this.p.providerCallId);
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.p.apiKey}` },
    });
    this.ws = ws;

    // Setup watchdog: covers BOTH connecting and configuring — cleared only once
    // the session reaches 'active' (or finalizes).
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.setupTimer = setTimeout(() => {
      if (this.state === 'connecting' || this.state === 'configuring') {
        this.p.logger.warn({ voiceCallId: this.p.voiceCallId }, 'voice session setup timeout');
        ws.terminate();
      }
    }, SETUP_TIMEOUT_MS);

    ws.on('open', () => {
      // Wait for session.created before sending anything (protocol contract).
    });
    ws.on('message', (data) => {
      // Strictly sequential: an async handler (e.g. response.created flushing
      // transcripts) must complete before the next event — otherwise deltas and
      // tool calls arriving mid-await would be reset by its continuation.
      const raw = String(data);
      this.processing = this.processing.then(() => this.onMessage(raw));
    });
    ws.on('error', (err) => {
      this.p.logger.warn(
        { voiceCallId: this.p.voiceCallId, err: toErrorInfo(err) },
        'voice ws error'
      );
    });
    ws.on('close', (code) => {
      // Serialized with event handling so a close never races an in-flight
      // response.done / tool execution (finding: chain bypass).
      this.processing = this.processing.then(() => this.onWsClose(code));
    });
    ws.on('pong', () => {
      /* liveness only */
    });
  }

  // --- inbound protocol events -------------------------------------------------

  private async onMessage(raw: string): Promise<void> {
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return; // non-JSON frame — ignore
    }
    const peek = serverEventSchema.safeParse(event);
    if (!peek.success) return;
    const type = peek.data.type;

    try {
      switch (true) {
        case type === 'session.created':
          await this.onSessionCreated();
          break;
        case type === 'session.updated':
          await this.onSessionUpdated();
          break;
        case type === 'conversation.item.input_audio_transcription.updated': {
          const parsed = transcriptionUpdatedSchema.safeParse(event);
          // CUMULATIVE transcript: keep only the latest value per item_id.
          if (parsed.success) this.userTranscripts.set(parsed.data.item_id, parsed.data.transcript);
          break;
        }
        case type === 'conversation.item.input_audio_transcription.completed': {
          const parsed = transcriptionCompletedSchema.safeParse(event);
          if (parsed.success) {
            this.userTranscripts.set(parsed.data.item_id, parsed.data.transcript);
            // The final ASR text may arrive AFTER the turn was flushed at
            // response.created — correct the persisted message then.
            await this.flushUserTranscript(parsed.data.item_id);
          }
          break;
        }
        case type === 'response.created':
          // A new assistant turn starts. Reset BEFORE any await so events that
          // could interleave can never be wiped by this handler's continuation.
          this.botBuffer = '';
          this.sawAudioDelta = false;
          this.pendingToolCalls = [];
          // User speech before this response is final — flush it.
          await this.flushAllUserTranscripts();
          break;
        case type === 'response.audio_transcript.delta' ||
          type === 'response.output_audio_transcript.delta': {
          const parsed = outputTranscriptDeltaSchema.safeParse(event);
          if (parsed.success) {
            // Audio transcript takes precedence: drop any text-delta prefix that
            // sneaked in before the first audio delta of this response.
            if (!this.sawAudioDelta) this.botBuffer = '';
            this.sawAudioDelta = true;
            this.botBuffer += parsed.data.delta;
          }
          break;
        }
        case type === 'response.text.delta' || type === 'response.output_text.delta': {
          // Fallback stream when no audio transcript exists for this response.
          if (!this.sawAudioDelta) {
            const parsed = outputTextDeltaSchema.safeParse(event);
            if (parsed.success) this.botBuffer += parsed.data.delta;
          }
          break;
        }
        case type === 'response.function_call_arguments.done': {
          const parsed = functionCallArgsDoneSchema.safeParse(event);
          if (parsed.success) {
            this.pendingToolCalls.push({
              callId: parsed.data.call_id,
              name: parsed.data.name,
              rawArguments: parsed.data.arguments,
            });
          }
          break;
        }
        case type === 'response.done':
          await this.onResponseDone();
          break;
        case type === 'response.output_audio.delta':
          // SIP media flows Twilio↔xAI; drop stray audio frames, never log them.
          break;
        case type === 'error':
          this.p.logger.warn(
            { voiceCallId: this.p.voiceCallId, eventType: type },
            'voice ws error event'
          );
          break;
        default:
          // Unknown/uninteresting event types: ignore (log type only at debug).
          this.p.logger.debug(
            { voiceCallId: this.p.voiceCallId, eventType: type },
            'voice ws event'
          );
      }
    } catch (err) {
      this.p.logger.error(
        { voiceCallId: this.p.voiceCallId, eventType: type, err: toErrorInfo(err) },
        'voice event handling failed'
      );
    }
  }

  private async onSessionCreated(): Promise<void> {
    this.state = 'configuring';
    this.send(
      sessionUpdateEvent(buildSessionConfig(this.p.channelConfig, this.p.agent, this.p.context))
    );
  }

  private async onSessionUpdated(): Promise<void> {
    if (this.state !== 'configuring') return; // later config acks are no-ops
    this.state = 'active';
    if (this.setupTimer) clearTimeout(this.setupTimer);

    const firstActivation = this.startedAtMs === null;
    if (firstActivation) {
      this.startedAtMs = Date.now();
      await this.p.supabase
        .from('voice_calls')
        .update({ status: 'active', started_at: new Date().toISOString() })
        .eq('id', this.p.voiceCallId);

      // Watchdogs: WS liveness ping + hard max-duration cap (armed ONCE).
      this.maxDurationTimer = setTimeout(() => {
        void this.endByWatchdog();
      }, this.p.channelConfig.maxCallSeconds * 1000);

      // Recording (opt-in): the §201-StGB consent notice MUST be the first
      // thing spoken — force_message guarantees the exact wording (a prompt
      // instruction would only be probabilistic). Recording start runs in
      // parallel and is best-effort: a Twilio failure never kills the call.
      if (this.p.recording) {
        this.send(forceMessageEvent(RECORDING_NOTICE_TEXT));
        void this.startRecording(this.p.recording);
        // Defer the greeting to the notice's response.done — sending it now,
        // while the force_message turn is still active, drops it.
        this.greetPending = true;
      } else {
        // Greet the caller (first activation only — a rejoin must not re-greet).
        this.send(responseCreateEvent());
      }
    }

    // Ping is per-connection: clear a previous connection's timer before re-arming.
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.ws?.ping(), PING_INTERVAL_MS);
  }

  /**
   * Starts the Twilio dual-channel recording and stamps both SIDs into
   * voice_calls.metadata — the post-call job needs recording_sid to move the
   * audio to Supabase Storage and delete it at Twilio. Best-effort by design.
   */
  private async startRecording(rec: {
    creds: TwilioRecordingCreds;
    twilioCallSid: string;
  }): Promise<void> {
    try {
      const recordingSid = await startCallRecording(rec.creds, rec.twilioCallSid);
      await this.p.supabase
        .from('voice_calls')
        .update({
          metadata: { twilio_call_sid: rec.twilioCallSid, recording_sid: recordingSid },
        })
        .eq('id', this.p.voiceCallId);
      this.p.logger.info({ voiceCallId: this.p.voiceCallId }, 'voice recording started');
    } catch (err) {
      this.p.logger.warn(
        { voiceCallId: this.p.voiceCallId, err: toErrorInfo(err) },
        'voice recording start failed — call continues unrecorded'
      );
    }
  }

  private async onResponseDone(): Promise<void> {
    // 1. Persist the assistant turn.
    if (this.botBuffer.trim().length > 0) {
      await this.insertMessage('out', 'bot', this.botBuffer.trim());
      this.botBuffer = '';
      this.sawAudioDelta = false;
    }

    // 1a. The §201 notice just finished — now greet, back-to-back, no dead air.
    if (this.greetPending && this.state === 'active') {
      this.greetPending = false;
      this.send(responseCreateEvent());
      return; // the notice carries no tool calls
    }

    // 2. Execute collected tool calls (possibly several in parallel), answer
    //    each with a function_call_output, then exactly ONE response.create.
    if (this.pendingToolCalls.length > 0 && this.state === 'active') {
      const calls = this.pendingToolCalls;
      this.pendingToolCalls = [];
      let endCallRequested = false;
      let transferNumber: string | null = null;
      let transferCallId: string | null = null;

      const results = await Promise.all(
        calls.map(async (call) => {
          const output = await this.runTool(call.name, call.rawArguments);
          if (output && typeof output === 'object' && 'action' in output) {
            if ((output as { action?: string }).action === 'transfer') {
              transferNumber = (output as { transfer_number?: string }).transfer_number ?? null;
              transferCallId = call.callId;
            }
          }
          if (call.name === 'end_call') endCallRequested = true;
          return { callId: call.callId, output };
        })
      );

      if (transferNumber) {
        // Live handoff: hold message, REFER while the session is still alive,
        // and only mark 'transferred' once the REFER succeeded. On failure the
        // session stays active and the model falls back to the callback flow.
        this.send(forceMessageEvent(TRANSFER_HOLD_TEXT));
        try {
          await referCall(this.p.apiKey, this.p.providerCallId, `tel:${transferNumber}`);
          this.state = 'ending';
          this.endedReason = 'handoff_transfer';
          // xAI tears the session down after the transfer; onWsClose finalizes.
          return;
        } catch (err) {
          this.p.logger.error(
            { voiceCallId: this.p.voiceCallId, err: toErrorInfo(err) },
            'voice refer failed — falling back to callback flow'
          );
          for (const r of results) {
            const output =
              r.callId === transferCallId
                ? {
                    ok: true,
                    action: 'callback',
                    instruction:
                      'Die Weiterleitung ist fehlgeschlagen. Entschuldige dich kurz, biete einen Rückruf an: erfrage Name und Rückrufnummer, rufe create_ticket auf und beende dann mit end_call.',
                  }
                : r.output;
            if (output !== null) this.send(functionCallOutputEvent(r.callId, output));
          }
          this.send(responseCreateEvent());
          return;
        }
      }

      if (endCallRequested) {
        this.state = 'ending';
        this.endedReason = 'agent_end';
        for (const r of results) {
          if (r.output !== null) this.send(functionCallOutputEvent(r.callId, r.output));
        }
        // Farewell was already spoken before the tool call; hang up now.
        try {
          await hangupCall(this.p.apiKey, this.p.providerCallId);
        } catch (err) {
          this.p.logger.warn(
            { voiceCallId: this.p.voiceCallId, err: toErrorInfo(err) },
            'voice hangup failed'
          );
          this.ws?.close();
        }
        return;
      }

      for (const r of results) {
        if (r.output !== null) this.send(functionCallOutputEvent(r.callId, r.output));
      }
      this.send(responseCreateEvent());
    }
  }

  private async runTool(name: string, rawArguments: string): Promise<unknown> {
    let args: unknown;
    try {
      args = JSON.parse(rawArguments);
    } catch {
      return { ok: false, error: 'invalid arguments' };
    }
    const ctx: ToolContext = {
      supabase: this.p.supabase,
      orgId: this.p.orgId,
      conversationId: this.p.conversationId,
      channelId: this.p.channelId,
      channelConfig: this.p.channelConfig,
      agentMode: this.p.agent.mode,
      knowledgeBaseIds: this.p.agent.knowledgeBaseIds,
    };
    try {
      switch (name) {
        case 'kb_search':
          return await kbSearchTool(ctx, args);
        case 'create_ticket':
          return await createTicketTool(ctx, args);
        case 'handoff_human':
          return await handoffTool(ctx, args);
        case 'end_call':
          return { ok: true };
        default:
          return { ok: false, error: 'unknown tool' };
      }
    } catch (err) {
      this.p.logger.error(
        { voiceCallId: this.p.voiceCallId, tool: name, err: toErrorInfo(err) },
        'voice tool failed'
      );
      return { ok: false, error: 'tool execution failed' };
    }
  }

  // --- transcript persistence ---------------------------------------------------

  /**
   * Persists (or corrects) a user turn. First flush inserts the message and
   * remembers its id; a later, different final transcript for the same item
   * (ASR 'completed' arriving after the response.created flush) updates the row
   * instead of being dropped.
   */
  private async flushUserTranscript(itemId: string): Promise<void> {
    const transcript = this.userTranscripts.get(itemId)?.trim();
    if (!transcript || transcript.length === 0) return;

    const flushed = this.flushedItems.get(itemId);
    if (flushed) {
      if (flushed.content === transcript || !flushed.messageId) return;
      flushed.content = transcript;
      await this.p.supabase
        .from('messages')
        .update({ content: transcript })
        .eq('org_id', this.p.orgId)
        .eq('id', flushed.messageId);
      return;
    }

    // processing_state='skipped': turns are answered live in-call; the text
    // pipeline must not draft a second reply for them.
    const messageId = await this.insertMessage('in', 'contact', transcript, 'skipped');
    this.flushedItems.set(itemId, { messageId, content: transcript });
  }

  private async flushAllUserTranscripts(): Promise<void> {
    for (const itemId of this.userTranscripts.keys()) {
      await this.flushUserTranscript(itemId);
    }
  }

  private async insertMessage(
    direction: 'in' | 'out',
    senderType: 'contact' | 'bot' | 'system',
    content: string,
    processingState: 'skipped' | null = null
  ): Promise<string | null> {
    const { data, error } = await this.p.supabase
      .from('messages')
      .insert({
        org_id: this.p.orgId,
        conversation_id: this.p.conversationId,
        channel_id: this.p.channelId,
        direction,
        sender_type: senderType,
        content,
        content_type: 'text',
        processing_state: direction === 'in' ? processingState : null,
      })
      .select('id')
      .single();
    if (error) {
      this.p.logger.error(
        { voiceCallId: this.p.voiceCallId, err: toErrorInfo(error) },
        'voice transcript insert failed'
      );
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  }

  // --- lifecycle end paths --------------------------------------------------------

  private async endByWatchdog(): Promise<void> {
    if (this.state !== 'active') return;
    this.state = 'ending';
    this.endedReason = 'max_duration';
    this.send(forceMessageEvent(GOODBYE_TIMEOUT_TEXT));
    // Give the farewell a moment to play out, then hang up.
    setTimeout(() => {
      void hangupCall(this.p.apiKey, this.p.providerCallId).catch(() => this.ws?.close());
    }, 8_000);
  }

  /**
   * Graceful shutdown (worker deploy/restart): farewell + hangup, then WAIT for
   * finalize so tail transcripts and the voice_calls row are committed before
   * the process exits.
   */
  async drain(): Promise<void> {
    if (this.state === 'closed') return;
    if (this.state === 'active') {
      this.state = 'ending';
      this.endedReason = 'worker_shutdown';
      this.send(forceMessageEvent(GOODBYE_TIMEOUT_TEXT));
      await new Promise((r) => setTimeout(r, DRAIN_FAREWELL_MS));
      try {
        await hangupCall(this.p.apiKey, this.p.providerCallId);
      } catch {
        this.ws?.terminate();
      }
    } else {
      this.endedReason = this.endedReason ?? 'worker_shutdown';
      this.ws?.terminate();
    }
    // Wait for finalize (bounded — never block shutdown forever).
    await Promise.race([this.closed, new Promise((r) => setTimeout(r, DRAIN_MAX_WAIT_MS))]);
  }

  private async onWsClose(code?: number): Promise<void> {
    if (this.state === 'closed') return;

    // Connection never reached 'active': that is a setup failure, not a
    // completed call (finding: connect failure was finalized as 'completed').
    if (this.startedAtMs === null && this.endedReason === null) {
      await this.finalize('failed', 'connect_failed');
      return;
    }

    // Normal remote hangup (WS close 1000) — the common way callers end a call.
    const normalClose = code === 1000;

    // Unexpected drop while active → exactly one rejoin attempt.
    if (
      this.state === 'active' &&
      !normalClose &&
      !this.reconnectAttempted &&
      this.endedReason === null
    ) {
      this.reconnectAttempted = true;
      this.state = 'connecting';
      this.p.logger.warn({ voiceCallId: this.p.voiceCallId }, 'voice ws dropped — rejoining once');
      setTimeout(() => {
        if (this.state === 'connecting') this.connect();
      }, 2_000);
      return;
    }

    // Rejoin attempt itself failed → the call is lost.
    if (
      this.reconnectAttempted &&
      this.endedReason === null &&
      this.state !== 'ending' &&
      !normalClose
    ) {
      await this.finalize('failed', 'reconnect_failed');
      return;
    }

    await this.finalize(
      this.endedReason === 'handoff_transfer' ? 'transferred' : 'completed',
      this.endedReason ?? 'remote_close'
    );
  }

  private async finalize(
    status: 'completed' | 'failed' | 'transferred',
    reason: string
  ): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    if (this.setupTimer) clearTimeout(this.setupTimer);

    // Persist any tail turns: pending user transcripts AND a bot turn that was
    // cut off mid-response (finding: botBuffer lost on early close).
    await this.flushAllUserTranscripts();
    if (this.botBuffer.trim().length > 0) {
      await this.insertMessage('out', 'bot', this.botBuffer.trim());
      this.botBuffer = '';
    }

    const durationSeconds = this.startedAtMs
      ? Math.round((Date.now() - this.startedAtMs) / 1000)
      : null;
    await this.p.supabase
      .from('voice_calls')
      .update({
        status,
        ended_at: new Date().toISOString(),
        duration_seconds: durationSeconds,
        ended_reason: reason,
      })
      .eq('id', this.p.voiceCallId);

    if (durationSeconds !== null) {
      const mm = String(Math.floor(durationSeconds / 60)).padStart(2, '0');
      const ss = String(durationSeconds % 60).padStart(2, '0');
      await this.insertMessage('out', 'system', `Anruf beendet (${mm}:${ss}).`);
    }

    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }

    if (!this.closedNotified) {
      this.closedNotified = true;
      this.p.onClosed(this.p.providerCallId);
    }
    this.closedResolve?.();
  }

  private send(frame: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    }
  }
}
