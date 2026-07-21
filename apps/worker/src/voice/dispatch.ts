import { z } from 'zod';
import type { Logger, SupabaseClient } from '@zendori/core';
import { loadWorkerEnv } from '@zendori/core';
import {
  businessHoursSchema,
  voiceChannelConfigSchema,
  type BusinessHours,
} from '@zendori/channels';
import { getServiceClient, toErrorInfo } from '../db.js';
import { CallSession } from './call-session.js';
import type { VoiceAgentBehavior } from './session-config.js';

// Voice dispatch (Phase 9): the ingress-free worker learns about incoming calls
// via a Supabase Realtime broadcast (0009 trigger on voice_calls, private topic
// 'voice-dispatch') and joins the call's xAI WebSocket. Broadcast is
// at-most-once, so a 3s sweep over status='ringing' rows is the fallback; rows
// ringing for >30s are marked 'missed'. Peer of startScan in main() — returns a
// stop function; teardown drains active sessions gracefully.

const RING_SWEEP_INTERVAL_MS = 3_000;
const RING_MISSED_AFTER_MS = 30_000;
const DEFAULT_MAX_CONCURRENT_CALLS = 10;
const RESUBSCRIBE_DELAY_MS = 5_000;

const dispatchPayloadSchema = z.object({
  voice_call_id: z.uuid(),
  provider_call_id: z.string().min(1),
  org_id: z.uuid(),
  channel_id: z.uuid(),
});

interface RingingCallRow {
  id: string;
  provider_call_id: string;
  org_id: string;
  channel_id: string;
  conversation_id: string;
  created_at: string;
  /** Webhook-captured extras, e.g. twilio_call_sid for per-call recording. */
  metadata: Record<string, unknown> | null;
}

export interface VoiceDispatchHandle {
  stop: () => Promise<void>;
  /** Test seam: number of live sessions. */
  activeSessions: () => number;
}

/** Missing-table error while migration 0009 is not applied yet. */
function isMissingTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '42P01';
}

/** Undefined-column error while migration 0011 (channels.agent_id) is pending. */
function isUndefinedColumn(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '42703';
}

export function startVoiceDispatch(logger: Logger): VoiceDispatchHandle {
  const env = loadWorkerEnv();
  const apiKey = env.XAI_API_KEY;
  if (!apiKey) {
    logger.info('voice dispatch disabled (XAI_API_KEY not set)');
    return { stop: async () => undefined, activeSessions: () => 0 };
  }
  const maxConcurrent = env.VOICE_MAX_CONCURRENT_CALLS ?? DEFAULT_MAX_CONCURRENT_CALLS;

  const supabase = getServiceClient();
  const sessions = new Map<string, CallSession>();
  let stopped = false;

  // --- claim + join ------------------------------------------------------------

  const releaseClaim = async (voiceCallId: string): Promise<void> => {
    // Put the row back to ringing so the sweep can retry (transient failure).
    await supabase
      .from('voice_calls')
      .update({ status: 'ringing', claimed_at: null })
      .eq('id', voiceCallId)
      .eq('status', 'connecting');
  };

  const claimAndJoin = async (voiceCallId: string): Promise<void> => {
    if (sessions.size >= maxConcurrent) {
      logger.warn({ voiceCallId }, 'voice concurrency cap reached — not claiming');
      return;
    }

    // Atomic claim: only the transition ringing→connecting proceeds.
    const { data: claimed, error: claimError } = await supabase
      .from('voice_calls')
      .update({ status: 'connecting', claimed_at: new Date().toISOString() })
      .eq('id', voiceCallId)
      .eq('status', 'ringing')
      .select('id, provider_call_id, org_id, channel_id, conversation_id, created_at, metadata');
    if (claimError) {
      if (!isMissingTable(claimError)) {
        logger.error({ voiceCallId, err: toErrorInfo(claimError) }, 'voice claim failed');
      }
      return;
    }
    const call = ((claimed ?? [])[0] as RingingCallRow | undefined) ?? null;
    if (!call) return; // already claimed / no longer ringing

    // Cap re-check AFTER the claim (broadcast bursts race the size check above):
    // the loser releases the claim so the sweep retries once capacity frees up.
    if (sessions.size >= maxConcurrent) {
      logger.warn({ voiceCallId }, 'voice concurrency cap hit post-claim — releasing');
      await releaseClaim(call.id);
      return;
    }

    // Load channel config + org name for the session. Transient load errors
    // must NOT terminally fail the call — release it back to ringing instead.
    const loads = await Promise.all([
      supabase.from('channels').select('config, agent_id').eq('id', call.channel_id).maybeSingle(),
      supabase.from('organizations').select('name').eq('id', call.org_id).maybeSingle(),
      supabase
        .from('conversations')
        .select('contact_id, contacts(name)')
        .eq('id', call.conversation_id)
        .maybeSingle(),
      // 0018: handoff needs business hours + the org keyword list. Best-effort —
      // a failure here degrades to "hours unconfigured/default keywords", it
      // must never block answering the call.
      supabase
        .from('org_settings')
        .select('business_hours, escalation_keywords')
        .eq('org_id', call.org_id)
        .maybeSingle(),
    ]);
    let channelRes = loads[0];
    const [, orgRes, contactRes, settingsRes] = loads;
    if (isUndefinedColumn(channelRes.error)) {
      // channels.agent_id not migrated yet (worker ahead of 0011): answer the
      // call anyway — retry without the column; the null agent below falls back
      // to safe intake mode. Releasing would just loop until 'missed'.
      logger.warn({ voiceCallId }, 'channels.agent_id missing — is migration 0011 applied?');
      channelRes = (await supabase
        .from('channels')
        .select('config')
        .eq('id', call.channel_id)
        .maybeSingle()) as typeof channelRes;
    }
    if (channelRes.error || orgRes.error || contactRes.error) {
      logger.warn(
        { voiceCallId, err: toErrorInfo(channelRes.error ?? orgRes.error ?? contactRes.error) },
        'voice claim context load failed — releasing back to ringing'
      );
      await releaseClaim(call.id);
      return;
    }
    if (!channelRes.data) {
      // Channel row truly gone — that IS terminal.
      await supabase
        .from('voice_calls')
        .update({
          status: 'failed',
          ended_reason: 'invalid_config',
          ended_at: new Date().toISOString(),
        })
        .eq('id', call.id);
      return;
    }
    const configResult = voiceChannelConfigSchema.safeParse(
      (channelRes.data as { config: unknown }).config
    );
    if (!configResult.success) {
      logger.error({ voiceCallId }, 'voice channel config invalid — failing call');
      await supabase
        .from('voice_calls')
        .update({
          status: 'failed',
          ended_reason: 'invalid_config',
          ended_at: new Date().toISOString(),
        })
        .eq('id', call.id);
      return;
    }
    const companyName = (orgRes.data as { name: string } | null)?.name ?? 'unserem Unternehmen';
    const contactName =
      ((contactRes.data as { contacts: { name: string | null } | null } | null)?.contacts?.name ??
        null) ||
      null;

    // Defensive parse of the 0018 handoff inputs (best-effort — see above).
    const settingsRow = settingsRes.error
      ? null
      : (settingsRes.data as {
          business_hours: unknown;
          escalation_keywords: unknown;
        } | null);
    let businessHours: BusinessHours | null = null;
    if (settingsRow?.business_hours != null) {
      const parsed = businessHoursSchema.safeParse(settingsRow.business_hours);
      businessHours = parsed.success ? parsed.data : null;
    }
    const keywordsParsed = z.array(z.string()).safeParse(settingsRow?.escalation_keywords);
    const escalationKeywords = keywordsParsed.success ? keywordsParsed.data : [];

    // Resolve the assigned agent (0011). A live call cannot simply "not answer",
    // so a missing/paused agent falls back to safe intake mode (take the case,
    // no RAG answers) with a warning; transient load errors release the claim.
    const agentId = (channelRes.data as { agent_id?: string | null }).agent_id ?? null;
    // Agent-less fallback: safe intake, handoff on user_request possible but
    // NEVER a live transfer (allowTransfer stays false — no owner-configured
    // behavior to trust).
    let agent: VoiceAgentBehavior = {
      mode: 'intake_only',
      identity: null,
      knowledgeBaseIds: null,
      handoffEnabled: true,
    };
    let allowTransfer = false;
    if (agentId) {
      // Column-skew chain: handoff_enabled is 0018, kind is 0015 — degrade
      // select-by-select while migrations are pending.
      let agentRes = await supabase
        .from('agents')
        .select('identity, mode, is_active, kind, handoff_enabled')
        .eq('id', agentId)
        .maybeSingle();
      if (isUndefinedColumn(agentRes.error)) {
        logger.warn({ voiceCallId }, 'agents.handoff_enabled missing — is migration 0018 applied?');
        agentRes = (await supabase
          .from('agents')
          .select('identity, mode, is_active, kind')
          .eq('id', agentId)
          .maybeSingle()) as typeof agentRes;
      }
      if (isUndefinedColumn(agentRes.error)) {
        // agents.kind not migrated yet (worker ahead of 0015): retry without it.
        logger.warn({ voiceCallId }, 'agents.kind missing — is migration 0015 applied?');
        agentRes = (await supabase
          .from('agents')
          .select('identity, mode, is_active')
          .eq('id', agentId)
          .maybeSingle()) as typeof agentRes;
      }
      if (agentRes.error && isMissingTable(agentRes.error)) {
        // agents table not migrated yet: answer in safe intake mode instead of
        // release-looping the call into 'missed'.
        logger.warn({ voiceCallId }, 'agents table missing — is migration 0011 applied?');
      } else if (agentRes.error) {
        logger.warn(
          { voiceCallId, err: toErrorInfo(agentRes.error) },
          'voice agent load failed — releasing back to ringing'
        );
        await releaseClaim(call.id);
        return;
      }
      const row = agentRes.data as {
        identity: string | null;
        mode: string;
        is_active: boolean;
        kind?: string;
        handoff_enabled?: boolean;
      } | null;
      if (row && row.kind === 'text') {
        // A text agent on a voice channel (pre-0015 data — the DB guard blocks
        // this going forward): its identity is written for chat/mail, not for a
        // live call. Fall back to the neutral intake mode.
        logger.warn({ voiceCallId }, 'text agent assigned to voice channel — intake fallback');
      } else if (row && row.is_active) {
        // autopilot → live answering; draft_only/intake_only → intake (a call
        // cannot present a draft for human review first). kb_search is scoped
        // to the agent's linked bases (0012); pre-0012 table → null = all.
        let knowledgeBaseIds: string[] | null = null;
        const kbRes = await supabase
          .from('agent_knowledge_bases')
          .select('knowledge_base_id')
          .eq('agent_id', agentId);
        if (kbRes.error && !isMissingTable(kbRes.error)) {
          logger.warn(
            { voiceCallId, err: toErrorInfo(kbRes.error) },
            'voice agent kb-link load failed — releasing back to ringing'
          );
          await releaseClaim(call.id);
          return;
        }
        if (!kbRes.error) {
          knowledgeBaseIds = ((kbRes.data ?? []) as { knowledge_base_id: string }[]).map(
            (r) => r.knowledge_base_id
          );
        }
        agent = {
          mode: row.mode === 'autopilot' ? 'answer' : 'intake_only',
          identity: row.identity ?? null,
          knowledgeBaseIds,
          // pre-0018 rows: default ON = today's behavior
          handoffEnabled: row.handoff_enabled !== false,
        };
        // A real, active, owner-configured agent answered — live transfer allowed.
        allowTransfer = true;
      } else {
        logger.warn({ voiceCallId }, 'voice agent missing/paused — falling back to intake mode');
      }
    } else {
      logger.warn({ voiceCallId }, 'voice channel has no agent — falling back to intake mode');
    }

    // Recording (opt-in): capture is done trunk-wide at Twilio (Elastic SIP
    // Trunking calls are not recordable via the per-call Voice API). The session
    // only speaks the §201 consent notice; the post-call job fetches the trunk
    // recording by CallSid and moves it to EU storage.
    const recordingEnabled = configResult.data.recordingEnabled === true;

    const session = new CallSession({
      supabase,
      logger,
      apiKey,
      voiceCallId: call.id,
      providerCallId: call.provider_call_id,
      orgId: call.org_id,
      channelId: call.channel_id,
      conversationId: call.conversation_id,
      channelConfig: configResult.data,
      agent,
      context: { companyName, contactName, escalationKeywords },
      businessHours,
      allowTransfer,
      recordingEnabled,
      onClosed: (providerCallId) => {
        sessions.delete(providerCallId);
      },
    });
    sessions.set(call.provider_call_id, session);
    session.start();
    logger.info({ voiceCallId }, 'voice call claimed');
  };

  // --- realtime subscription (primary signal) -----------------------------------
  // Resubscribe carefully: realtime-js dedupes channels by topic, so the old
  // channel must be FULLY removed (awaited) before a new subscribe — otherwise
  // subscribe() no-ops on the dying channel and the dispatch dead-ends silently.

  let channel: ReturnType<typeof buildChannel> | null = null;
  let resubscribing = false;

  function buildChannel() {
    return supabase
      .channel('voice-dispatch', { config: { private: true } })
      .on('broadcast', { event: 'incoming_call' }, (message: { payload?: unknown }) => {
        const parsed = dispatchPayloadSchema.safeParse(message.payload);
        if (!parsed.success) return;
        void claimAndJoin(parsed.data.voice_call_id);
      })
      .subscribe((status) => {
        if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !stopped && !resubscribing) {
          resubscribing = true;
          logger.warn({ status }, 'voice dispatch realtime channel degraded — resubscribing');
          setTimeout(() => {
            void (async () => {
              try {
                if (channel) await supabase.removeChannel(channel);
              } catch (err) {
                logger.warn({ err: toErrorInfo(err) }, 'voice dispatch channel removal failed');
              }
              resubscribing = false;
              if (!stopped) channel = buildChannel();
            })();
          }, RESUBSCRIBE_DELAY_MS);
        }
      });
  }

  // --- ringing sweep (fallback, at-most-once broadcast) ---------------------------

  let sweeping = false;
  const sweep = async (): Promise<void> => {
    if (sweeping || stopped) return;
    sweeping = true;
    try {
      const { data, error } = await supabase
        .from('voice_calls')
        .select('id, created_at')
        .eq('status', 'ringing')
        .order('created_at', { ascending: true })
        .limit(10);
      if (error) {
        if (isMissingTable(error)) return; // migration 0009 not applied yet
        throw error;
      }
      const now = Date.now();
      for (const row of (data ?? []) as { id: string; created_at: string }[]) {
        const ageMs = now - Date.parse(row.created_at);
        if (ageMs > RING_MISSED_AFTER_MS) {
          await markMissed(supabase, logger, row.id);
        } else {
          await claimAndJoin(row.id);
        }
      }
    } catch (err) {
      logger.error({ err: toErrorInfo(err) }, 'voice ring sweep failed');
    } finally {
      sweeping = false;
    }
  };

  let sweepInterval: ReturnType<typeof setInterval> | null = null;

  // Ordered async init: orphan cleanup FIRST (so it can never race a call this
  // process claims), then subscribe, then start the sweep.
  const init = (async () => {
    const { error } = await supabase
      .from('voice_calls')
      .update({
        status: 'failed',
        ended_at: new Date().toISOString(),
        ended_reason: 'worker_restart',
      })
      .in('status', ['connecting', 'active']);
    if (error && !isMissingTable(error)) {
      logger.error({ err: toErrorInfo(error) }, 'voice orphan cleanup failed');
    }
    if (stopped) return;
    channel = buildChannel();
    sweepInterval = setInterval(() => {
      void sweep();
    }, RING_SWEEP_INTERVAL_MS);
    logger.info('voice dispatch started');
  })().catch((err: unknown) => {
    logger.error({ err: toErrorInfo(err) }, 'voice dispatch init failed');
  });

  return {
    stop: async () => {
      stopped = true;
      await init;
      if (sweepInterval) clearInterval(sweepInterval);
      if (channel) {
        try {
          await supabase.removeChannel(channel);
        } catch {
          /* connection may already be down */
        }
      }
      // Graceful drain: farewell + hangup for each live call; drain() waits for
      // finalize so transcripts and voice_calls rows are committed before exit.
      await Promise.all([...sessions.values()].map((s) => s.drain()));
    },
    activeSessions: () => sessions.size,
  };
}

async function markMissed(
  supabase: SupabaseClient,
  logger: Logger,
  voiceCallId: string
): Promise<void> {
  const { data } = await supabase
    .from('voice_calls')
    .update({ status: 'missed', ended_at: new Date().toISOString(), ended_reason: 'not_claimed' })
    .eq('id', voiceCallId)
    .eq('status', 'ringing')
    .select('org_id, channel_id, conversation_id');
  const row =
    ((data ?? [])[0] as
      | { org_id: string; channel_id: string; conversation_id: string }
      | undefined) ?? null;
  if (!row) return;
  logger.warn({ voiceCallId }, 'voice call missed (never claimed)');
  await supabase.from('messages').insert({
    org_id: row.org_id,
    conversation_id: row.conversation_id,
    channel_id: row.channel_id,
    direction: 'out',
    sender_type: 'system',
    content: 'Verpasster Anruf — der Sprachassistent konnte nicht rechtzeitig annehmen.',
    content_type: 'text',
    processing_state: null,
  });
}
