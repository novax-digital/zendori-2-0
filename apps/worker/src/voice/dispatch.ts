import { z } from 'zod';
import type { Logger, SupabaseClient } from '@zendori/core';
import { loadWorkerEnv } from '@zendori/core';
import { voiceChannelConfigSchema } from '@zendori/channels';
import { getServiceClient, toErrorInfo } from '../db.js';
import { CallSession } from './call-session.js';

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
      .select('id, provider_call_id, org_id, channel_id, conversation_id, created_at');
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
    const [channelRes, orgRes, contactRes] = await Promise.all([
      supabase.from('channels').select('config').eq('id', call.channel_id).maybeSingle(),
      supabase.from('organizations').select('name').eq('id', call.org_id).maybeSingle(),
      supabase
        .from('conversations')
        .select('contact_id, contacts(name)')
        .eq('id', call.conversation_id)
        .maybeSingle(),
    ]);
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
      context: { companyName, contactName },
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
