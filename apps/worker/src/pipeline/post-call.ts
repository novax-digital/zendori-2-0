import { AI_MODELS, classify, extract } from '@zendori/ai';
import type { ConversationPriority, SupabaseClient } from '@zendori/core';
import { createLogger, loadWorkerEnv, refineOpenTicket, voiceMinutesCostUsd } from '@zendori/core';
import { getServiceClient, isMissingColumnError, toErrorInfo } from '../db.js';
import { maybeRequestHubspotSync } from './process-message.js';
import { recordUsage } from './usage.js';
import {
  deleteRecording,
  fetchRecordingWav,
  findRecordingSidByCall,
  type TwilioRecordingCreds,
} from '../voice/recording.js';

// Post-call AI (Phase 9): once a voice call ends, run classify + extract (the
// Bridge prompts, same as the text pipeline) over the full transcript to give
// the inbox a consistent subject/priority and to fill contact gaps from what
// the caller said. Enqueued by the scan for ended calls without
// post_processed_at; idempotent via the stamp.

export const POST_CALL_QUEUE = 'voice.post-call';
export const POST_CALL_RETRY_LIMIT = 2;

/**
 * Terminal-failure stamp: after the last retry, mark the call processed anyway
 * so the scan stops re-enqueuing it (otherwise every 3s tick would retry paid
 * LLM calls forever). The transcript stays in the inbox; only the automatic
 * subject/priority refinement is skipped.
 */
export async function markPostCallTerminal(voiceCallId: string): Promise<void> {
  const supabase = getServiceClient();
  const { data } = await supabase
    .from('voice_calls')
    .update({ post_processed_at: new Date().toISOString() })
    .eq('id', voiceCallId)
    .is('post_processed_at', null)
    .select('org_id, channel_id, conversation_id');
  // Only the AI refinement failed — the transcript conversation exists and
  // still belongs in HubSpot per the org's rules. The RETURNING clause doubles
  // as the idempotency gate: a second terminal call updates 0 rows.
  const row = ((data ?? []) as { org_id: string; channel_id: string; conversation_id: string }[])[0];
  if (row) {
    await maybeRequestHubspotSync(supabase, row.org_id, row.channel_id, row.conversation_id);
  }
}

const log = createLogger('voice-post-call');

const DEFAULT_CATEGORIES = ['Frage', 'Störung', 'Reklamation', 'Bestellung', 'Sonstiges'];
const MAX_TRANSCRIPT_CHARS = 24_000;

interface VoiceCallRow {
  id: string;
  org_id: string;
  channel_id: string;
  conversation_id: string;
  status: string;
  duration_seconds: number | null;
  post_processed_at: string | null;
  /** Webhook/session-written extras: twilio_call_sid, recording_stored_at. */
  metadata: Record<string, unknown> | null;
}

const RECORDING_POLL_ATTEMPTS = 3;
const RECORDING_POLL_DELAY_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Moves the finished trunk recording to Supabase Storage (EU) and deletes it at
 * Twilio (§7: the US-stored copy is transient). Recording happens trunk-wide
 * (see recording.ts); here we look the call's recording up by CallSid, so the
 * channel must have opted in (`recordingEnabled`). Best-effort by design: any
 * failure logs and returns — the transcript is the primary record, and the
 * recording stays fetchable at Twilio for manual recovery. Idempotent via
 * metadata.recording_stored_at.
 */
async function maybeStoreRecording(
  supabase: SupabaseClient,
  call: VoiceCallRow
): Promise<void> {
  const meta = call.metadata ?? {};
  if (meta.recording_stored_at) return; // already stored (idempotent)

  // Gate on the channel's opt-in: without it we'd probe Twilio for a recording
  // that was never made on every single call.
  const { data: channelRow } = await supabase
    .from('channels')
    .select('config')
    .eq('id', call.channel_id)
    .maybeSingle();
  const config = (channelRow as { config?: Record<string, unknown> } | null)?.config ?? {};
  if (config.recordingEnabled !== true) return;

  const twilioCallSid = typeof meta.twilio_call_sid === 'string' ? meta.twilio_call_sid : null;
  if (!twilioCallSid) {
    log.warn({ voiceCallId: call.id }, 'recording enabled but no twilio_call_sid captured');
    return;
  }

  const env = loadWorkerEnv();
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    log.warn({ voiceCallId: call.id }, 'recording enabled but TWILIO_* creds missing');
    return;
  }
  const creds: TwilioRecordingCreds = {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
  };

  // Declared out here so the outer catch can log the sid if it was found.
  let recordingSid: string | null = null;
  try {
    // Trunk recording is finalized shortly after hangup — poll for it to be
    // listed under the account, then for the WAV to finish processing.
    let wav: Uint8Array | null = null;
    for (let attempt = 0; attempt < RECORDING_POLL_ATTEMPTS; attempt += 1) {
      if (!recordingSid) recordingSid = await findRecordingSidByCall(creds, twilioCallSid);
      if (recordingSid) {
        wav = await fetchRecordingWav(creds, recordingSid);
        if (wav) break;
      }
      if (attempt < RECORDING_POLL_ATTEMPTS - 1) await sleep(RECORDING_POLL_DELAY_MS);
    }
    if (!recordingSid) {
      log.warn(
        { voiceCallId: call.id, twilioCallSid },
        'no trunk recording found for call — is trunk recording enabled?'
      );
      return;
    }
    if (!wav) {
      log.warn(
        { voiceCallId: call.id, recordingSid },
        'recording not ready — left at Twilio for manual recovery'
      );
      return;
    }

    // Upload first (path is org-scoped for the storage RLS), then message +
    // attachment row, then stamp + delete at Twilio.
    const path = `${call.org_id}/${call.id}/aufzeichnung.wav`;
    const { error: uploadError } = await supabase.storage
      .from('attachments')
      .upload(path, wav, { contentType: 'audio/wav', upsert: true });
    if (uploadError) {
      log.warn({ voiceCallId: call.id, recordingSid }, 'recording upload failed');
      return;
    }
    const { data: msgRow, error: msgError } = await supabase
      .from('messages')
      .insert({
        org_id: call.org_id,
        conversation_id: call.conversation_id,
        channel_id: call.channel_id,
        direction: 'out',
        sender_type: 'system',
        content: 'Gesprächsaufzeichnung zum Anruf.',
        content_type: 'text',
        processing_state: null,
      })
      .select('id')
      .single();
    if (msgError || !msgRow) {
      log.warn({ voiceCallId: call.id }, 'recording message insert failed');
      return;
    }
    await supabase.from('attachments').insert({
      org_id: call.org_id,
      message_id: (msgRow as { id: string }).id,
      storage_path: path,
      mime: 'audio/wav',
      size: wav.byteLength,
    });
    await supabase
      .from('voice_calls')
      .update({ metadata: { ...meta, recording_stored_at: new Date().toISOString() } })
      .eq('id', call.id);
    try {
      await deleteRecording(creds, recordingSid);
    } catch (err) {
      log.warn(
        { voiceCallId: call.id, recordingSid, err: toErrorInfo(err) },
        'recording delete at Twilio failed — delete manually'
      );
    }
    log.info({ voiceCallId: call.id }, 'recording stored');
  } catch (err) {
    log.warn(
      { voiceCallId: call.id, recordingSid, err: toErrorInfo(err) },
      'recording transfer failed — left at Twilio'
    );
  }
}

export async function processPostCall(voiceCallId: string): Promise<void> {
  const supabase = getServiceClient();

  const { data: callData } = await supabase
    .from('voice_calls')
    .select(
      'id, org_id, channel_id, conversation_id, status, duration_seconds, post_processed_at, metadata'
    )
    .eq('id', voiceCallId)
    .maybeSingle();
  const call = callData as VoiceCallRow | null;
  if (!call || call.post_processed_at !== null) return; // gone or already processed

  // Bill the live voice minutes (0021, xAI audio + Twilio SIP via the rate card).
  // dedup_key 'voice:<id>' makes this idempotent across AI retries; best-effort
  // so metering never blocks the transcript pipeline. Runs before the
  // missed-call early return so connected-but-silent calls are still billed.
  const minutes = Math.max(0, call.duration_seconds ?? 0) / 60;
  await recordUsage(
    supabase,
    {
      orgId: call.org_id,
      channelId: call.channel_id,
      conversationId: call.conversation_id,
      category: 'voice_minutes',
      provider: 'xai',
      quantity: minutes,
      unit: 'minutes',
      costUsd: voiceMinutesCostUsd(minutes),
      dedupKey: `voice:${call.id}`,
      sourceRef: call.id,
      metadata: { duration_seconds: call.duration_seconds ?? 0 },
    },
    log
  );

  // Recording transfer runs BEFORE the AI part and is best-effort: it must
  // neither block classification nor be re-run on AI retries (own stamp).
  await maybeStoreRecording(supabase, call);

  const stamp = async (): Promise<void> => {
    await supabase
      .from('voice_calls')
      .update({ post_processed_at: new Date().toISOString() })
      .eq('id', call.id);
  };

  // Missed calls / calls without transcript: stamp and stop.
  const { data: messageData } = await supabase
    .from('messages')
    .select('direction, sender_type, content')
    .eq('org_id', call.org_id)
    .eq('conversation_id', call.conversation_id)
    .in('sender_type', ['contact', 'bot'])
    .order('created_at', { ascending: true })
    .limit(200);
  const turns = (messageData ?? []) as {
    direction: string;
    sender_type: string;
    content: string;
  }[];
  if (turns.length === 0) {
    await stamp();
    // Even a missed/silent call is an inbox conversation ("Verpasster Anruf") —
    // if the org's rules say so, it belongs in HubSpot like any other.
    await maybeRequestHubspotSync(supabase, call.org_id, call.channel_id, call.conversation_id);
    return;
  }

  const transcript = turns
    .map((t) => `${t.sender_type === 'contact' ? 'Anrufer' : 'Assistent'}: ${t.content}`)
    .join('\n')
    .slice(0, MAX_TRANSCRIPT_CHARS);

  const { data: orgRow } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', call.org_id)
    .maybeSingle();
  const companyName = (orgRow as { name: string } | null)?.name ?? 'Unternehmen';

  try {
    // classify → priority; extract → subject/contact (Bridge prompts).
    const classifyStart = Date.now();
    const { result: classification, costUsd: classifyCost } = await classify({
      companyName,
      channelType: 'voice',
      subject: null,
      body: transcript,
    });
    await logRun(supabase, call, 'classify', classifyCost, Date.now() - classifyStart, {
      outputSummary: `intent=${classification.intent} priority=${classification.priority}`,
    });

    const extractStart = Date.now();
    const { result: extraction, costUsd: extractCost } = await extract({
      companyName,
      categories: DEFAULT_CATEGORIES,
      channelType: 'voice',
      subject: null,
      body: transcript,
    });
    await logRun(supabase, call, 'extract', extractCost, Date.now() - extractStart, {
      confidence: extraction.confidence,
      outputSummary: `category=${extraction.category}`,
    });

    // Subject: keep an agent/tool-set subject if it is more specific than the
    // webhook default ("Anruf von …"); otherwise use the extraction.
    const { data: convRow } = await supabase
      .from('conversations')
      .select('subject, contact_id')
      .eq('org_id', call.org_id)
      .eq('id', call.conversation_id)
      .maybeSingle();
    const conv = convRow as { subject: string | null; contact_id: string | null } | null;
    const isDefaultSubject =
      !conv?.subject ||
      conv.subject.startsWith('Anruf von') ||
      conv.subject === 'Eingehender Anruf';

    const updates: { subject?: string; priority?: ConversationPriority } = {
      priority: classification.priority,
    };
    if (isDefaultSubject && extraction.subject && extraction.subject.trim().length > 0) {
      updates.subject = extraction.subject.trim().slice(0, 200);
    }
    await supabase
      .from('conversations')
      .update(updates)
      .eq('org_id', call.org_id)
      .eq('id', call.conversation_id);

    // Phase 11: refine the call's open ticket the same way (priority always,
    // subject only over the placeholder). No ticket → nothing (a call without
    // an intake gets none here). Best-effort.
    try {
      await refineOpenTicket(supabase, {
        orgId: call.org_id,
        conversationId: call.conversation_id,
        priority: classification.priority,
        subject: extraction.subject,
        mode: 'gapfill',
      });
    } catch (err) {
      log.warn({ voiceCallId: call.id, err: toErrorInfo(err) }, 'post-call ticket refinement failed');
    }

    // Fill contact gaps from the extraction (never overwrite existing values).
    if (conv?.contact_id) {
      let contactRes = await supabase
        .from('contacts')
        .select('name, email, company')
        .eq('org_id', call.org_id)
        .eq('id', conv.contact_id)
        .maybeSingle();
      const companyColumnMissing = isMissingColumnError(contactRes.error);
      if (companyColumnMissing) {
        // contacts.company not migrated yet (worker ahead of 0027) — retry without.
        contactRes = (await supabase
          .from('contacts')
          .select('name, email')
          .eq('org_id', call.org_id)
          .eq('id', conv.contact_id)
          .maybeSingle()) as typeof contactRes;
      }
      const contact = contactRes.data as {
        name: string | null;
        email: string | null;
        company?: string | null;
      } | null;
      // Gap-only semantics need the current values: never patch off a failed read.
      if (!contactRes.error && contact) {
        const patch: Record<string, string> = {};
        if (extraction.contact.name && !contact.name) patch.name = extraction.contact.name;
        // NO e-mail gap-fill for voice (review 2026-09-03, owner defect #2): the
        // transcript is raw ASR text — a mis-heard address the caller rejected
        // during the spell-back would be extracted and stored here anyway. The
        // only trusted e-mail source for a call is create_ticket's confirmed
        // path, which already wrote contacts.email before this job runs; an
        // empty column at this point means the address was never confirmed.
        if (extraction.contact.company && !companyColumnMissing && !contact.company) {
          patch.company = extraction.contact.company;
        }
        if (Object.keys(patch).length > 0) {
          const { error: patchError } = await supabase
            .from('contacts')
            .update(patch)
            .eq('org_id', call.org_id)
            .eq('id', conv.contact_id);
          if (patchError && isMissingColumnError(patchError) && patch.company) {
            // Pre-0027 skew: drop company so name/email still land.
            delete patch.company;
            if (Object.keys(patch).length > 0) {
              await supabase
                .from('contacts')
                .update(patch)
                .eq('org_id', call.org_id)
                .eq('id', conv.contact_id);
            }
          }
        }
      }
    }
  } catch (err) {
    log.error({ voiceCallId, err: toErrorInfo(err) }, 'post-call AI failed');
    throw err; // pg-boss retries; the stamp below only happens on success
  }

  await stamp();

  // Voice's ONLY automatic HubSpot hook (the fix for "Anrufe kommen nie
  // automatisch in HubSpot an"): calls bypass the text pipeline entirely
  // (transcript turns are stored processing_state='skipped'), so none of the
  // six maybeRequestHubspotSync call sites in process-message.ts ever fire for
  // them. Requested AFTER the subject/priority refinement above so the ticket
  // is created from the enriched conversation. Best-effort inside the helper;
  // rules (all | channels | manual) are evaluated there.
  await maybeRequestHubspotSync(supabase, call.org_id, call.channel_id, call.conversation_id);
}

async function logRun(
  supabase: SupabaseClient,
  call: VoiceCallRow,
  step: 'classify' | 'extract',
  costUsd: number,
  latencyMs: number,
  extra: { confidence?: number; outputSummary: string }
): Promise<void> {
  await supabase.from('ai_runs').insert({
    org_id: call.org_id,
    conversation_id: call.conversation_id,
    step,
    model: AI_MODELS.classify,
    confidence: extra.confidence ?? null,
    latency_ms: latencyMs,
    cost_usd: costUsd,
    input_summary: 'voice.post_call',
    output_summary: extra.outputSummary,
  });
}
