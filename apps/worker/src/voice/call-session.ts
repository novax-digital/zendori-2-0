import WebSocket from 'ws';
import type { Logger, SupabaseClient } from '@zendori/core';
import type { BusinessHours, VoiceChannelConfig } from '@zendori/channels';
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

// One CallSession per live call: holds the outbound WebSocket to xAI for the
// duration of the conversation, persists transcript turns as normal `messages`
// rows (the inbox streams them via the existing realtime UI), executes the
// function tools with the bound org_id, and finalizes the voice_calls row on
// every exit path. Never logs transcript content or audio (§7) — only ids,
// event types and error shapes.

// Expectation-setting on purpose (0018): after a successful SIP REFER we cannot
// observe ring-no-answer — the promise of a callback is the caller-side safety
// net when nobody picks up. Kept SHORT: the REFER waits for the spoken duration
// (playback grace below), so every extra word delays the actual transfer.
const TRANSFER_HOLD_TEXT =
  'Einen Moment, ich verbinde Sie. Falls niemand erreichbar ist, melden wir uns zurück.';
/** Mandatory §201-StGB consent notice — spoken verbatim BEFORE the greeting. */
const RECORDING_NOTICE_TEXT =
  'Dieses Gespräch wird zur Qualitätssicherung aufgezeichnet.';
const GOODBYE_TIMEOUT_TEXT =
  'Wir müssen das Gespräch aus technischen Gründen beenden. Wir rufen Sie schnellstmöglich zurück. Auf Wiederhören.';
const PING_INTERVAL_MS = 15_000;
/** Covers connecting AND configuring — a session must reach 'active' within this. */
const SETUP_TIMEOUT_MS = 15_000;
/**
 * Safety net for the §201-notice → greeting handoff: the greeting is normally
 * fired on the notice force_message's `response.done`. xAI emitting that event
 * for a force_message turn is UNVERIFIED live — if it never comes, the greeting
 * would hang forever (dead air after the notice). This timer fires the greeting
 * once the notice has surely finished, so the caller is never left in silence.
 * Long enough that it can only elapse after the short notice has played out
 * (firing mid-notice would drop the greeting — see greetPending).
 */
const GREET_FALLBACK_MS = 6_000;
/**
 * Short breather between the §201 notice and the greeting (owner feedback
 * 2026-07-23: notice and greeting butted up against each other; 1.2s was
 * still "zu hektisch" → 1.5s). Applied only on the response.done path — the
 * fallback path has already waited longer.
 */
const NOTICE_GREETING_PAUSE_MS = 1_500;
const DRAIN_FAREWELL_MS = 4_000;
const DRAIN_MAX_WAIT_MS = 10_000;
/**
 * Latency filler (owner feedback 2026-07-23): the model no longer ritually
 * announces lookups (session-config.ts) — a FAST tool batch plays out in
 * natural silence. Only a batch still running after this delay gets exactly
 * ONE short spoken filler via force_message. Tune HERE if fillers arrive too
 * early (annoying) or too late (dead air).
 */
export const TOOL_FILLER_DELAY_MS = 1_500;
/**
 * Rotated per call so a caller never hears the same filler twice in a row.
 * Spoken verbatim — keep them SHORT; they play while the lookup finishes.
 */
export const TOOL_FILLER_TEXTS = [
  'Einen Moment bitte, ich schaue das gerade nach.',
  'Ich prüfe das kurz für Sie.',
  'Das sehe ich gerade für Sie nach.',
];
/**
 * Ticket-only batches (esp. intake_only, where create_ticket IS the flow) must
 * not claim a "lookup" is happening — the caller expects their Anliegen to be
 * RECORDED, not researched.
 */
export const TICKET_FILLER_TEXTS = [
  'Einen Moment bitte, ich nehme das gerade für Sie auf.',
  'Ich notiere das kurz für Sie.',
  'Ich halte das gerade für Sie fest.',
];

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
  /** Org business hours (0018) — the handoff tool gates transfers on them. */
  businessHours?: BusinessHours | null;
  /** False in the agent-less safe-intake fallback: never live-transfer. */
  allowTransfer?: boolean;
  /**
   * True when the channel opted into recording. The actual capture is done at
   * the Twilio trunk level (Elastic SIP Trunking calls are not recordable via
   * the per-call Voice API); the session only speaks the mandatory §201 consent
   * notice before the greeting. The post-call job moves the trunk recording to
   * EU storage.
   */
  recordingEnabled?: boolean;
  /** Called exactly once when the session reaches `closed` (registry cleanup). */
  onClosed: (providerCallId: string) => void;
  /** Test seam: overrides the WS URL (mock server). */
  wsUrl?: string;
  /** Test seam: overrides the greeting-fallback delay (defaults to GREET_FALLBACK_MS). */
  greetFallbackMs?: number;
  /** Test seam: overrides the playback graces (end_call→hangup, hold→REFER). */
  hangupGraceMs?: number;
  /** Test seam: overrides the latency-filler delay (defaults to TOOL_FILLER_DELAY_MS). */
  toolFillerDelayMs?: number;
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
  /** Breather between §201 notice and greeting (NOTICE_GREETING_PAUSE_MS). */
  private noticePauseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Safety-net timer that fires the deferred greeting if the notice's response.done never arrives. */
  private greetFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set by the failed-transfer fallback: the response.create that lets the model
   * continue is deferred to the hold force_message's response.done (sending it
   * mid-force_message drops it — the greeting bug's sibling). Fallback timer
   * mirrors the greeting one.
   */
  private pendingResponseCreate = false;
  private responseCreateFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Grace timer between end_call and the actual hangup (playback drain). */
  private endCallTimer: ReturnType<typeof setTimeout> | null = null;
  /** Latency-filler timer for the in-flight tool batch (see onResponseDone). */
  private toolFillerTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rotates through TOOL_FILLER_TEXTS within a call (never the same twice in a row). */
  private fillerIndex = 0;
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
      // instruction would only be probabilistic). Capture itself happens at the
      // trunk level (see recording.ts); the post-call job fetches it.
      if (this.p.recordingEnabled) {
        this.send(forceMessageEvent(RECORDING_NOTICE_TEXT));
        // Defer the greeting to the notice's response.done — sending it now,
        // while the force_message turn is still active, drops it. If that event
        // never arrives (unverified for force_message turns), the fallback timer
        // fires the greeting once the notice has surely finished.
        this.greetPending = true;
        this.greetFallbackTimer = setTimeout(
          () => this.fireDeferredGreeting(),
          this.p.greetFallbackMs ?? GREET_FALLBACK_MS
        );
      } else {
        // Greet the caller (first activation only — a rejoin must not re-greet).
        this.sendGreeting();
      }
    }

    // Ping is per-connection: clear a previous connection's timer before re-arming.
    // OPEN guard is load-bearing (audit 2026-07-21): ws.ping() THROWS synchronously
    // on a CONNECTING socket — an unguarded tick during the rejoin handshake was
    // an uncaught exception that killed the whole worker process.
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
    }, PING_INTERVAL_MS);
  }

  /**
   * Greets the caller. A CONFIGURED greeting is spoken verbatim via
   * force_message — exact wording, and the channel's greetingInterruptible
   * toggle decides whether the caller can barge in (default: no, the opening
   * plays out fully). Without a configured greeting the model generates one
   * (response.create; barge-in applies as in any normal turn). Live evidence
   * (2026-07-21): force_message turns DO stream transcript deltas + response.done,
   * so the greeting is persisted through the normal transcript path.
   */
  private sendGreeting(): void {
    const greeting = this.p.channelConfig.greeting?.trim();
    if (greeting) {
      this.send(forceMessageEvent(greeting, this.p.channelConfig.greetingInterruptible === true));
    } else {
      this.send(responseCreateEvent());
    }
  }

  /**
   * Fires the greeting deferred behind the §201 notice — idempotent, so the
   * notice's response.done and the fallback timer can race without double-
   * greeting (whichever wins clears greetPending; the other becomes a no-op).
   * The flag is ALWAYS consumed: a non-active session gives the greeting up
   * instead of leaving it armed — a stuck flag would re-greet mid-call after a
   * rejoin and swallow that turn's tool calls (audit 2026-07-21).
   */
  private fireDeferredGreeting(pauseMs = 0): void {
    if (!this.greetPending) return;
    this.greetPending = false;
    if (this.greetFallbackTimer) {
      clearTimeout(this.greetFallbackTimer);
      this.greetFallbackTimer = null;
    }
    if (this.state !== 'active') return;
    if (pauseMs > 0) {
      // Short breather after the §201 notice (owner feedback 2026-07-23) —
      // only on the response.done path; the fallback already waited longer.
      this.noticePauseTimer = setTimeout(() => {
        if (this.state === 'active') this.sendGreeting();
      }, pauseMs);
      return;
    }
    this.sendGreeting();
  }

  /** Deferred response.create twin of fireDeferredGreeting (failed-transfer path). */
  private fireDeferredResponseCreate(): void {
    if (!this.pendingResponseCreate) return;
    this.pendingResponseCreate = false;
    if (this.responseCreateFallbackTimer) {
      clearTimeout(this.responseCreateFallbackTimer);
      this.responseCreateFallbackTimer = null;
    }
    if (this.state !== 'active') return;
    this.send(responseCreateEvent());
  }

  private async onResponseDone(): Promise<void> {
    // 1. Persist the assistant turn. Remember its length BEFORE the flush — the
    //    end_call grace period below estimates the remaining playback from it.
    const lastTurnChars = this.botBuffer.trim().length;
    if (lastTurnChars > 0) {
      await this.insertMessage('out', 'bot', this.botBuffer.trim());
      this.botBuffer = '';
      this.sawAudioDelta = false;
    }

    // 1a. The §201 notice just finished — greet after a short natural pause.
    if (this.greetPending) {
      this.fireDeferredGreeting(NOTICE_GREETING_PAUSE_MS);
      // The notice carries no tool calls — but a rejoin edge can route a REAL
      // turn's response.done here; never swallow its tool calls.
      if (this.pendingToolCalls.length === 0) return;
    }

    // 1b. A deferred response.create (failed-transfer fallback) waits for the
    // hold force_message's response.done — same drop semantics as the greeting.
    if (this.pendingResponseCreate) {
      this.fireDeferredResponseCreate();
      if (this.pendingToolCalls.length === 0) return;
    }

    // 2. Execute collected tool calls (possibly several in parallel), answer
    //    each with a function_call_output, then exactly ONE response.create.
    if (this.pendingToolCalls.length > 0 && this.state === 'active') {
      const calls = this.pendingToolCalls;
      this.pendingToolCalls = [];
      let endCallRequested = false;
      let transferNumber: string | null = null;
      let transferCallId: string | null = null;
      let transferEventId: string | null = null;

      // Latency filler (owner feedback 2026-07-23): fast lookups stay silent —
      // only a batch still running after TOOL_FILLER_DELAY_MS gets ONE short
      // spoken bridge via force_message. Armed only when EVERY call is
      // kb_search/create_ticket: handoff_human speaks its own hold text and
      // end_call must never be talked over. The timer fires OUTSIDE the
      // serialized event chain, but only performs a socket write (send) — it
      // never touches chain-owned state, so existing ordering is untouched.
      const fillerEligible = calls.every(
        (c) => c.name === 'kb_search' || c.name === 'create_ticket'
      );
      // Wording per batch: any lookup present → lookup phrasing; ticket-only →
      // recording phrasing (shared fillerIndex keeps rotation call-wide).
      const fillerTexts = calls.some((c) => c.name === 'kb_search')
        ? TOOL_FILLER_TEXTS
        : TICKET_FILLER_TEXTS;
      let fillerSpoken = false;
      if (fillerEligible) {
        this.toolFillerTimer = setTimeout(() => {
          this.toolFillerTimer = null;
          // Mirror the transfer-path guard: an abnormal close arriving
          // mid-batch queues BEHIND the blocked response.done handler, so
          // state alone can lie. A filler "spoken" into a dead socket would
          // wrongly defer the batch's response.create into a rejoined session
          // (orphaned forced turn).
          if (this.state !== 'active' || this.ws?.readyState !== WebSocket.OPEN) return;
          fillerSpoken = true;
          const text = fillerTexts[this.fillerIndex % fillerTexts.length]!;
          this.fillerIndex += 1;
          this.send(forceMessageEvent(text));
        }, this.p.toolFillerDelayMs ?? TOOL_FILLER_DELAY_MS);
      }

      const results = await Promise.all(
        calls.map(async (call) => {
          const output = await this.runTool(call.name, call.rawArguments);
          if (output && typeof output === 'object' && 'action' in output) {
            if ((output as { action?: string }).action === 'transfer') {
              transferNumber = (output as { transfer_number?: string }).transfer_number ?? null;
              transferCallId = call.callId;
              // Internal correlation id for the REFER outcome — NEVER sent to
              // the model (stripped below before function_call_output).
              transferEventId = (output as { eventId?: string }).eventId ?? null;
              delete (output as { eventId?: string }).eventId;
            }
          }
          if (call.name === 'end_call') endCallRequested = true;
          return { callId: call.callId, output };
        })
      );

      // Batch finished — a filler that has not fired yet must never fire.
      if (this.toolFillerTimer) {
        clearTimeout(this.toolFillerTimer);
        this.toolFillerTimer = null;
      }

      if (transferNumber) {
        // Live handoff: hold message, REFER while the session is still alive,
        // and only mark 'transferred' once the REFER succeeded. On failure the
        // session stays active and the model falls back to the callback flow.
        this.send(forceMessageEvent(TRANSFER_HOLD_TEXT));
        // Playback-drain grace (same class as the end_call farewell cutoff,
        // live 2026-07-21): the REFER executes in milliseconds and would yank
        // the audio path into ringing mid-sentence. Wait roughly the spoken
        // duration of the hold text (~14 chars/s) before transferring.
        const holdMs =
          this.p.hangupGraceMs ?? Math.min(9_000, TRANSFER_HOLD_TEXT.length * 70 + 800);
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        // Caller may have hung up while the hold text played — the close event
        // is queued behind this handler, so check the socket, not just state.
        if (this.state !== 'active' || this.ws?.readyState !== WebSocket.OPEN) {
          return;
        }
        try {
          await referCall(this.p.apiKey, this.p.providerCallId, `tel:${transferNumber}`);
          this.state = 'ending';
          this.endedReason = 'handoff_transfer';
          // Outcome funnel (0018): best-effort — the transfer already happened.
          if (transferEventId) {
            await this.p.supabase
              .from('handoff_events')
              .update({ outcome: 'transferred' })
              .eq('org_id', this.p.orgId)
              .eq('id', transferEventId);
          }
          // xAI tears the session down after the transfer; onWsClose finalizes.
          return;
        } catch (err) {
          this.p.logger.error(
            { voiceCallId: this.p.voiceCallId, err: toErrorInfo(err) },
            'voice refer failed — falling back to callback flow'
          );
          if (transferEventId) {
            await this.p.supabase
              .from('handoff_events')
              .update({ outcome: 'transfer_failed' })
              .eq('org_id', this.p.orgId)
              .eq('id', transferEventId);
          }
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
          // The hold force_message is still speaking — a response.create sent
          // now gets dropped (live-verified drop semantics, audit 2026-07-21).
          // Defer it to the hold turn's response.done; fallback after 6s.
          this.pendingResponseCreate = true;
          this.responseCreateFallbackTimer = setTimeout(
            () => this.fireDeferredResponseCreate(),
            this.p.greetFallbackMs ?? GREET_FALLBACK_MS
          );
          return;
        }
      }

      if (endCallRequested) {
        this.state = 'ending';
        this.endedReason = 'agent_end';
        for (const r of results) {
          if (r.output !== null) this.send(functionCallOutputEvent(r.callId, r.output));
        }
        // response.done means the farewell is fully GENERATED, not fully PLAYED
        // — the SIP/carrier pipeline buffers several seconds, and an immediate
        // hangup cut the goodbye mid-word (live 2026-07-21: "Dein Ticket
        // wurde—" *click*). Wait roughly the spoken duration of the final turn
        // (~14 chars/s German speech) before hanging up; the caller hanging up
        // first during the grace just finalizes normally.
        const graceMs =
          this.p.hangupGraceMs ?? Math.min(9_000, Math.max(2_500, lastTurnChars * 70 + 1_200));
        this.endCallTimer = setTimeout(() => {
          void hangupCall(this.p.apiKey, this.p.providerCallId).catch((err: unknown) => {
            this.p.logger.warn(
              { voiceCallId: this.p.voiceCallId, err: toErrorInfo(err) },
              'voice hangup failed'
            );
            this.ws?.close();
          });
        }, graceMs);
        return;
      }

      for (const r of results) {
        if (r.output !== null) this.send(functionCallOutputEvent(r.callId, r.output));
      }
      if (fillerSpoken) {
        // The filler force_message may still be speaking — a response.create
        // sent now would be dropped (live-verified drop semantics, audit
        // 2026-07-21). Defer it to the filler turn's response.done exactly like
        // the greeting and the failed-transfer path; the fallback timer is the
        // safety net if that response.done never arrives.
        this.pendingResponseCreate = true;
        this.responseCreateFallbackTimer = setTimeout(
          () => this.fireDeferredResponseCreate(),
          this.p.greetFallbackMs ?? GREET_FALLBACK_MS
        );
      } else {
        this.send(responseCreateEvent());
      }
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
      handoffEnabled: this.p.agent.handoffEnabled,
      businessHours: this.p.businessHours ?? null,
      allowTransfer: this.p.allowTransfer ?? false,
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
      // Non-active (connecting/rejoin gap/configuring): the socket may already
      // be closed, so terminate() emits no close event — finalize directly
      // instead of waiting for one that never comes (audit 2026-07-21). The
      // endedReason set here also cancels a scheduled rejoin connect().
      this.endedReason = this.endedReason ?? 'worker_shutdown';
      this.ws?.terminate();
      await this.finalize(this.startedAtMs !== null ? 'completed' : 'failed', this.endedReason);
    }
    // Wait for finalize (bounded — never block shutdown forever).
    await Promise.race([this.closed, new Promise((r) => setTimeout(r, DRAIN_MAX_WAIT_MS))]);
  }

  private async onWsClose(code?: number): Promise<void> {
    if (this.state === 'closed') return;
    // Close codes are diagnostic gold (which code does a caller hangup use?) —
    // log them always; content-free, §7-safe.
    this.p.logger.info(
      { voiceCallId: this.p.voiceCallId, closeCode: code ?? null, state: this.state },
      'voice ws closed'
    );

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
      // Stop pinging the dead/handshaking socket — re-armed on session.updated.
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.p.logger.warn({ voiceCallId: this.p.voiceCallId }, 'voice ws dropped — rejoining once');
      setTimeout(() => {
        // endedReason set = drain()/shutdown intervened — do NOT open a fresh
        // socket mid-shutdown (audit 2026-07-21).
        if (this.state === 'connecting' && this.endedReason === null) this.connect();
      }, 2_000);
      return;
    }

    // Rejoin attempt itself failed. Live evidence (2026-07-21): xAI closes the
    // WS abnormally (non-1000) when the CALLER hangs up, so every normal remote
    // hangup used to land here and was finalized as failed/reconnect_failed.
    // A call that already had an active phase is therefore treated as a remote
    // hangup (an ended call's ?call_id join is refused); only a call that never
    // became active stays a real failure.
    if (
      this.reconnectAttempted &&
      this.endedReason === null &&
      this.state !== 'ending' &&
      !normalClose
    ) {
      if (this.startedAtMs !== null) {
        // Almost certainly a caller hangup — but if the call is actually still
        // alive at xAI (worker-side outage), a best-effort hangup ends it there
        // instead of leaving the caller in dead air (audit 2026-07-21). An
        // already-ended call just 404s.
        void hangupCall(this.p.apiKey, this.p.providerCallId).catch(() => undefined);
        await this.finalize('completed', 'remote_close');
      } else {
        await this.finalize('failed', 'reconnect_failed');
      }
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
    if (this.greetFallbackTimer) clearTimeout(this.greetFallbackTimer);
    if (this.noticePauseTimer) clearTimeout(this.noticePauseTimer);
    if (this.responseCreateFallbackTimer) clearTimeout(this.responseCreateFallbackTimer);
    if (this.endCallTimer) clearTimeout(this.endCallTimer);
    if (this.toolFillerTimer) clearTimeout(this.toolFillerTimer);

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
