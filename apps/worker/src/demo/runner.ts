import type { Logger, SupabaseClient } from '@zendori/core';
import { demoTranscriptSchema, loadWorkerEnv, type DemoStatus } from '@zendori/core';
import { getServiceClient, toErrorInfo } from '../db.js';
import { hangupCall } from '../voice/xai-realtime.js';
import { buildDemoSessionConfig, demoGreeting } from './prompt.js';
import { DemoCallSession } from './session.js';
import {
  buildDemoTwiml,
  createDemoCall,
  DEFAULT_DEMO_SIP_PARAMS,
  dialingOutcome,
  endDemoCall,
  fetchDemoCallStatus,
  TwilioCallError,
  type TwilioCreds,
} from './twilio.js';
import { buildWebsiteSummary } from './website.js';
import { sendDemoLeadEmail } from './notify.js';

// Demo-Anruf runner (0032). Drives demo_calls through its lifecycle:
//   queued     → preparing (website briefing) → dialing (Twilio outbound call)
//   dialing    → polled at Twilio until answered (webhook flips to connecting)
//                or busy / no-answer / failed / timeout
//   connecting → join the xAI call WebSocket (DemoCallSession) → in_call → done
// Wake-ups: Supabase Realtime broadcast on the private 'demo-dispatch' topic
// (0032 trigger on queued/connecting) + a 2 s sweep as the at-most-once
// fallback. Single worker process (§2): in-process guards serialize starts.
// Peer of startVoiceDispatch in main(); never touches tenant data.

const SWEEP_INTERVAL_MS = 2_000;
const RESUBSCRIBE_DELAY_MS = 5_000;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_CALL_SECONDS = 240;
/** Hard buffer on top of maxCallSeconds for Twilio's TimeLimit (backstop only). */
const TWILIO_TIME_LIMIT_BUFFER_S = 60;
/** Twilio poll spacing per dialing call. */
const POLL_EVERY_MS = 3_000;
/** Ring (30 s) + answer + SIP bridge must complete within this. */
const DIAL_TIMEOUT_MS = 120_000;
const NOTIFY_MAX_ATTEMPTS = 3;

export interface DemoRunnerHandle {
  stop: () => Promise<void>;
  activeSessions: () => number;
}

interface DemoRow {
  id: string;
  company_name: string;
  contact_name: string;
  email: string | null;
  phone_e164: string;
  website_url: string | null;
  website_summary: string | null;
  prompt: string;
  status: DemoStatus;
  twilio_call_sid: string | null;
  provider_call_id: string | null;
  dialed_at: string | null;
  duration_seconds: number | null;
  created_at: string;
  transcript: unknown;
  notify_attempts: number;
}

const ROW_FIELDS =
  'id, company_name, contact_name, email, phone_e164, website_url, website_summary, prompt, status, twilio_call_sid, provider_call_id, dialed_at, duration_seconds, created_at, transcript, notify_attempts';

function isMissingTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '42P01';
}

export function startDemoRunner(logger: Logger): DemoRunnerHandle {
  const env = loadWorkerEnv();
  const apiKey = env.XAI_API_KEY;
  const demoNumber = env.DEMO_VOICE_NUMBER;
  if (!apiKey || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !demoNumber) {
    logger.info('demo runner disabled (needs XAI_API_KEY, TWILIO_ACCOUNT_SID/AUTH_TOKEN, DEMO_VOICE_NUMBER)');
    return { stop: async () => undefined, activeSessions: () => 0 };
  }
  const creds: TwilioCreds = { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN };
  const maxConcurrent = env.DEMO_MAX_CONCURRENT_CALLS ?? DEFAULT_MAX_CONCURRENT;
  const maxCallSeconds = env.DEMO_MAX_CALL_SECONDS ?? DEFAULT_MAX_CALL_SECONDS;
  const voice = env.DEMO_VOICE ?? 'eve';
  const sipParams = env.DEMO_SIP_PARAMS ?? DEFAULT_DEMO_SIP_PARAMS;
  const notifyEmail = env.DEMO_NOTIFY_EMAIL ?? null;
  const adminUrl = `${(process.env.APP_URL ?? 'https://app.zendori.ai').replace(/\/+$/, '')}/admin/demo`;

  const supabase: SupabaseClient = getServiceClient();
  const sessions = new Map<string, DemoCallSession>();
  const joining = new Set<string>();
  const lastPolled = new Map<string, number>();
  let stopped = false;

  // --- queued → preparing → dialing ----------------------------------------------
  // Serialized: the cap check (DB count) and the claim must not interleave with
  // another start, or a broadcast + sweep burst could exceed the cap.
  let startChain: Promise<void> = Promise.resolve();
  const enqueueStart = (id: string): void => {
    startChain = startChain.then(() => startQueued(id)).catch((err: unknown) => {
      logger.error({ demoCallId: id, err: toErrorInfo(err) }, 'demo start failed');
    });
  };

  const failRow = async (id: string, from: DemoStatus, detail: string): Promise<void> => {
    await supabase
      .from('demo_calls')
      .update({ status: 'failed', status_detail: detail, ended_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', from);
  };

  async function startQueued(id: string): Promise<void> {
    if (stopped) return;
    const { count, error: countError } = await supabase
      .from('demo_calls')
      .select('id', { count: 'exact', head: true })
      .in('status', ['preparing', 'dialing', 'connecting', 'in_call']);
    if (countError) return;
    if ((count ?? 0) >= maxConcurrent) return; // stays queued; the sweep retries

    const { data: claimed, error: claimError } = await supabase
      .from('demo_calls')
      .update({ status: 'preparing', claimed_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'queued')
      .select(ROW_FIELDS);
    if (claimError) return;
    const row = ((claimed ?? [])[0] as DemoRow | undefined) ?? null;
    if (!row) return;
    logger.info({ demoCallId: id }, 'demo call preparing');

    // Company briefing (best-effort, bounded). A redial reuses the stored one.
    if (!row.website_summary && row.website_url) {
      const summary = await buildWebsiteSummary(row.website_url, row.company_name, logger, id);
      if (summary) {
        await supabase.from('demo_calls').update({ website_summary: summary }).eq('id', id);
      }
    }

    const timeLimitSeconds = maxCallSeconds + TWILIO_TIME_LIMIT_BUFFER_S;
    try {
      const { sid } = await createDemoCall(creds, {
        to: row.phone_e164,
        from: demoNumber!,
        twiml: buildDemoTwiml({ demoNumber: demoNumber!, demoCallId: id, sipParams, timeLimitSeconds }),
        timeLimitSeconds,
      });
      const { data: moved } = await supabase
        .from('demo_calls')
        .update({ status: 'dialing', twilio_call_sid: sid, dialed_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'preparing')
        .select('id');
      if ((moved ?? []).length === 0) {
        // row vanished (deleted) mid-prepare — do not leave a call ringing
        await endDemoCall(creds, sid).catch(() => undefined);
        return;
      }
      logger.info({ demoCallId: id }, 'demo call dialing');
    } catch (err) {
      const detail = err instanceof TwilioCallError ? err.failure : 'dial_failed';
      logger.warn({ demoCallId: id, detail, err: toErrorInfo(err) }, 'demo dial failed');
      await failRow(id, 'preparing', detail);
    }
  }

  // --- connecting → live session ---------------------------------------------------

  async function joinConnecting(id: string): Promise<void> {
    if (stopped || sessions.has(id) || joining.has(id)) return;
    joining.add(id);
    try {
      const { data, error } = await supabase
        .from('demo_calls')
        .select(ROW_FIELDS)
        .eq('id', id)
        .maybeSingle();
      const row = (data as DemoRow | null) ?? null;
      if (error || !row || row.status !== 'connecting' || !row.provider_call_id) return;
      const session = new DemoCallSession({
        supabase,
        logger,
        apiKey: apiKey!,
        demoCallId: id,
        providerCallId: row.provider_call_id,
        sessionConfig: buildDemoSessionConfig(
          {
            company: row.company_name,
            contactName: row.contact_name,
            prompt: row.prompt,
            websiteSummary: row.website_summary,
            maxCallSeconds,
          },
          { voice }
        ),
        greeting: demoGreeting({ company: row.company_name, contactName: row.contact_name }),
        maxCallSeconds,
        onClosed: (closedId) => {
          sessions.delete(closedId);
        },
      });
      sessions.set(id, session);
      session.start();
      logger.info({ demoCallId: id }, 'demo call joined');
    } finally {
      joining.delete(id);
    }
  }

  // --- dialing: poll Twilio until answered or terminal -----------------------------

  async function pollDialing(row: Pick<DemoRow, 'id' | 'twilio_call_sid' | 'dialed_at'>): Promise<void> {
    const now = Date.now();
    if ((lastPolled.get(row.id) ?? 0) + POLL_EVERY_MS > now) return;
    lastPolled.set(row.id, now);
    if (!row.twilio_call_sid) {
      await failRow(row.id, 'dialing', 'missing_call_sid');
      return;
    }
    const dialedAt = row.dialed_at ? Date.parse(row.dialed_at) : now;
    if (now - dialedAt > DIAL_TIMEOUT_MS) {
      await endDemoCall(creds, row.twilio_call_sid).catch(() => undefined);
      await failRow(row.id, 'dialing', 'dial_timeout');
      lastPolled.delete(row.id);
      return;
    }
    const status = await fetchDemoCallStatus(creds, row.twilio_call_sid).catch(() => null);
    if (!status) return;
    const outcome = dialingOutcome(status);
    if (!outcome) return;
    await supabase
      .from('demo_calls')
      .update({
        status: outcome.status,
        status_detail: outcome.detail,
        ended_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('status', 'dialing');
    lastPolled.delete(row.id);
    logger.info({ demoCallId: row.id, outcome: outcome.status }, 'demo call not connected');
  }

  // --- sales notification ----------------------------------------------------------

  async function notifyPending(): Promise<void> {
    if (!notifyEmail) return;
    const { data, error } = await supabase
      .from('demo_calls')
      .select(ROW_FIELDS)
      .eq('source', 'public')
      .in('status', ['completed', 'no_answer', 'busy', 'failed'])
      .is('notified_at', null)
      .lt('notify_attempts', NOTIFY_MAX_ATTEMPTS)
      .order('created_at', { ascending: true })
      .limit(3);
    if (error) return;
    for (const row of (data ?? []) as DemoRow[]) {
      const { data: claimed } = await supabase
        .from('demo_calls')
        .update({ notified_at: new Date().toISOString(), notify_attempts: row.notify_attempts + 1 })
        .eq('id', row.id)
        .is('notified_at', null)
        .select('id');
      if ((claimed ?? []).length === 0) continue;
      const transcript = demoTranscriptSchema.safeParse(row.transcript);
      try {
        await sendDemoLeadEmail(notifyEmail, {
          company: row.company_name,
          contactName: row.contact_name,
          email: row.email,
          phoneE164: row.phone_e164,
          websiteUrl: row.website_url,
          prompt: row.prompt,
          status: row.status,
          durationSeconds: row.duration_seconds,
          createdAt: row.created_at,
          transcript: transcript.success ? transcript.data : [],
          adminUrl,
        });
      } catch (err) {
        logger.warn({ demoCallId: row.id, err: toErrorInfo(err) }, 'demo lead mail failed');
        // release for a retry (attempts already counted)
        await supabase.from('demo_calls').update({ notified_at: null }).eq('id', row.id);
      }
    }
  }

  // --- sweep (fallback + housekeeping) ---------------------------------------------

  let sweeping = false;
  const sweep = async (): Promise<void> => {
    if (sweeping || stopped) return;
    sweeping = true;
    try {
      const { data, error } = await supabase
        .from('demo_calls')
        .select('id, status, twilio_call_sid, dialed_at')
        .in('status', ['queued', 'dialing', 'connecting'])
        .order('created_at', { ascending: true })
        .limit(20);
      if (error) {
        if (isMissingTable(error)) return; // migration 0032 not applied yet
        throw error;
      }
      for (const row of (data ?? []) as Pick<DemoRow, 'id' | 'status' | 'twilio_call_sid' | 'dialed_at'>[]) {
        if (row.status === 'queued') enqueueStart(row.id);
        else if (row.status === 'connecting') await joinConnecting(row.id);
        else if (row.status === 'dialing') await pollDialing(row);
      }
      // stale verifications: the web routes also report them, this makes it final
      await supabase
        .from('demo_calls')
        .update({ status: 'expired', status_detail: 'verify_expired' })
        .eq('status', 'awaiting_confirmation')
        .lt('verify_expires_at', new Date().toISOString());
      await notifyPending();
    } catch (err) {
      logger.error({ err: toErrorInfo(err) }, 'demo sweep failed');
    } finally {
      sweeping = false;
    }
  };

  // --- realtime subscription (primary signal) --------------------------------------

  let channel: ReturnType<typeof buildChannel> | null = null;
  let resubscribing = false;

  function buildChannel() {
    return supabase
      .channel('demo-dispatch', { config: { private: true } })
      .on('broadcast', { event: 'demo_call' }, (message: { payload?: unknown }) => {
        const payload = message.payload as { demo_call_id?: unknown; status?: unknown } | undefined;
        if (typeof payload?.demo_call_id !== 'string') return;
        if (payload.status === 'queued') enqueueStart(payload.demo_call_id);
        else if (payload.status === 'connecting') void joinConnecting(payload.demo_call_id);
      })
      .subscribe((status) => {
        if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !stopped && !resubscribing) {
          resubscribing = true;
          logger.warn({ status }, 'demo dispatch realtime channel degraded — resubscribing');
          setTimeout(() => {
            void (async () => {
              try {
                if (channel) await supabase.removeChannel(channel);
              } catch (err) {
                logger.warn({ err: toErrorInfo(err) }, 'demo dispatch channel removal failed');
              }
              resubscribing = false;
              if (!stopped) channel = buildChannel();
            })();
          }, RESUBSCRIBE_DELAY_MS);
        }
      });
  }

  let sweepInterval: ReturnType<typeof setInterval> | null = null;

  // Boot: live sessions of a previous process are gone — end them at xAI
  // (best-effort) and mark them failed; an interrupted prepare simply retries.
  // 'connecting' rows are NOT orphans: the lead may be answering right now and
  // the sweep joins them (a dead call fails the join → finalized as failed).
  const init = (async () => {
    const { data: orphans, error } = await supabase
      .from('demo_calls')
      .select('id, provider_call_id')
      .eq('status', 'in_call');
    if (error && !isMissingTable(error)) {
      logger.error({ err: toErrorInfo(error) }, 'demo orphan lookup failed');
    }
    for (const orphan of (orphans ?? []) as { id: string; provider_call_id: string | null }[]) {
      if (orphan.provider_call_id) {
        await hangupCall(apiKey, orphan.provider_call_id).catch(() => undefined);
      }
      await supabase
        .from('demo_calls')
        .update({ status: 'failed', status_detail: 'worker_restart', ended_at: new Date().toISOString() })
        .eq('id', orphan.id)
        .eq('status', 'in_call');
    }
    await supabase.from('demo_calls').update({ status: 'queued' }).eq('status', 'preparing');
    if (stopped) return;
    channel = buildChannel();
    sweepInterval = setInterval(() => {
      void sweep();
    }, SWEEP_INTERVAL_MS);
    logger.info({ maxConcurrent, maxCallSeconds }, 'demo runner started');
  })().catch((err: unknown) => {
    logger.error({ err: toErrorInfo(err) }, 'demo runner init failed');
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
      await startChain.catch(() => undefined);
      await Promise.all([...sessions.values()].map((s) => s.drain()));
    },
    activeSessions: () => sessions.size,
  };
}
