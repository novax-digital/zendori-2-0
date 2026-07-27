// Autopilot + human-handoff decision helpers for the Phase-5 worker pipeline
// (CLAUDE.md §6, §4 message-flow). detectHandoff / decideDraftAction /
// isAutopilotEnabled are pure and unit-tested; deliverBotReply performs the
// outbound persist + channel delivery. Message content is never logged (§7).
import { deliverOutboundEmail, deliverOutboundWhatsApp } from '@zendori/channels';
import type { ChannelType, HandoffReason, SupabaseClient } from '@zendori/core';
import {
  loadReleasedFiles,
  persistOutboundAttachments,
  type AttachedFile,
  type ReleasedFile,
} from './outbound-files.js';

export interface DetectHandoffInput {
  /** Draft confidence from the Sonnet draft step (0..1). */
  confidence: number;
  /** Org confidence_threshold (0..1). */
  threshold: number;
  /** classification.wants_human — the customer explicitly asked for a human. */
  wantsHuman: boolean;
  /** The (reply-stripped) inbound body used for escalation-keyword matching. */
  body: string;
  /** Org escalation_keywords, matched case-insensitively as substrings. */
  keywords: string[];
  /**
   * agents.handoff_enabled (0018). OFF suppresses ONLY the low_confidence
   * trigger — user_request and keyword ALWAYS hand off (a bot refusing an
   * explicit human wish is the worst loss path; keywords are org policy).
   */
  handoffEnabled: boolean;
}

export interface DetectHandoffResult {
  handoff: boolean;
  reason: HandoffReason | null;
  /**
   * True when a low_confidence trigger fired but was swallowed by the toggle.
   * A suppressed detection must NEVER auto-send (the confidence threshold
   * keeps gating quality even when it no longer escalates) — the draft stays
   * a pending suggestion, and a 'suppressed' outcome event keeps it countable.
   */
  suppressed: boolean;
}

/**
 * Decide whether an inbound message must be handed to a human (§6 triggers 1–3;
 * trigger 4 "Übernehmen" is a manual UI action handled in apps/web). When more
 * than one trigger fires we return a single, highest-priority reason —
 * keyword > user_request > low_confidence: a matched escalation keyword
 * (Kündigung, Beschwerde, …) is the strongest signal, an explicit human request
 * next, a low-confidence draft last. Exactly one reason ⇒ one handoff_event per
 * message. Pure.
 */
export function detectHandoff(input: DetectHandoffInput): DetectHandoffResult {
  if (matchesEscalationKeyword(input.body, input.keywords)) {
    return { handoff: true, reason: 'keyword', suppressed: false };
  }
  if (input.wantsHuman) {
    return { handoff: true, reason: 'user_request', suppressed: false };
  }
  if (input.confidence < input.threshold) {
    if (!input.handoffEnabled) {
      return { handoff: false, reason: null, suppressed: true };
    }
    return { handoff: true, reason: 'low_confidence', suppressed: false };
  }
  return { handoff: false, reason: null, suppressed: false };
}

/** Case-insensitive substring match of any non-empty escalation keyword. Pure. */
export function matchesEscalationKeyword(body: string, keywords: string[]): boolean {
  const haystack = body.toLowerCase();
  for (const keyword of keywords) {
    const needle = keyword.trim().toLowerCase();
    if (needle.length > 0 && haystack.includes(needle)) return true;
  }
  return false;
}

/** What to do with a freshly drafted reply in bot mode. */
export type DraftAction = 'handoff' | 'auto_send' | 'pending';

/**
 * Gate the drafted reply (§4 message-flow): a required handoff always wins; a
 * SUPPRESSED low-confidence detection (0018 toggle off) must never auto-send —
 * the draft below threshold stays a suggestion (the agent effectively behaves
 * like draft_only for that message); otherwise auto-send only when the
 * channel's assigned agent runs in autopilot mode (0011). Pure.
 */
export function decideDraftAction(
  handoff: boolean,
  autopilotEnabled: boolean,
  suppressed = false
): DraftAction {
  if (handoff) return 'handoff';
  if (suppressed) return 'pending';
  if (autopilotEnabled) return 'auto_send';
  return 'pending';
}

// --- outbound delivery -------------------------------------------------------

export interface DeliverBotReplyParams {
  conv: { id: string; org_id: string };
  channel: { id: string; type: ChannelType };
  content: string;
  /** 'bot' for auto-sent answers, 'system' for auto-ack notices (§6). */
  senderType: 'bot' | 'system';
  /**
   * Released knowledge-base files to attach (0025). Already gated by
   * resolveReleasedFiles: the answer used the source AND an owner released it.
   */
  files?: ReleasedFile[];
}

/**
 * Persist and deliver a bot/system outbound reply. Always inserts the outbound
 * `messages` row (direction='out'); for email it additionally sends via Resend
 * (storing metadata.email.message_id for threading) and for WhatsApp via the
 * provider adapter (storing metadata.whatsapp.message_sid for status matching).
 * A failed send is recorded (metadata.delivery.failed) and swallowed — it must
 * never kill the pipeline. Chat/Voice persist only; for chat the 0003 broadcast
 * trigger pushes the row to the widget. Never logs content (§7).
 */
export async function deliverBotReply(
  supabase: SupabaseClient,
  params: DeliverBotReplyParams
): Promise<void> {
  const { conv, channel, content, senderType } = params;
  // Voice can carry no file at all — drop them here rather than relying on the
  // persist-only branch below, so a future channel fallthrough cannot leak one.
  const requestedFiles = channel.type === 'voice' ? [] : (params.files ?? []);

  const { data: inserted, error: insertError } = await supabase
    .from('messages')
    .insert({
      org_id: conv.org_id,
      conversation_id: conv.id,
      channel_id: channel.id,
      direction: 'out',
      sender_type: senderType,
      content,
      content_type: 'text',
      processing_state: null,
    })
    .select('id')
    .single();
  if (insertError || !inserted) {
    throw insertError ?? new Error('outbound message insert returned no row');
  }
  const outboundId = (inserted as { id: string }).id;

  // Attachments are resolved AFTER the insert because their storage path is keyed
  // by the outbound message id. Every step is failure-tolerant: if anything about
  // a file goes wrong the text reply still goes out without it, recorded as
  // metadata.delivery.files_failed. The text must never fail because of a file.
  let attached: AttachedFile[] = [];
  let filesFailed = false;
  if (requestedFiles.length > 0) {
    try {
      const loaded = await loadReleasedFiles(supabase, requestedFiles);
      attached = await persistOutboundAttachments(supabase, {
        orgId: conv.org_id,
        messageId: outboundId,
        files: loaded,
      });
      filesFailed = attached.length < requestedFiles.length;
    } catch {
      filesFailed = true;
    }
  }

  // Email and WhatsApp actually deliver; both record the outcome on the row and
  // never throw. Chat/Voice persist only.
  let metadata: Record<string, unknown> | null = null;
  if (channel.type === 'email') {
    const result = await deliverOutboundEmail(supabase, {
      conversationId: conv.id,
      orgId: conv.org_id,
      channelId: channel.id,
      content,
      // Resend takes the bytes inline (base64), so we reuse the buffers we
      // already downloaded rather than reading them back out of storage.
      attachments: attached.map((file) => ({
        filename: file.filename,
        content: file.bytes.toString('base64'),
        contentType: file.mime,
      })),
    });
    metadata = result.ok
      ? { email: { message_id: result.messageId } }
      : { delivery: { failed: true, error: result.error } };
  } else if (channel.type === 'whatsapp') {
    // Bot/system re-engagement may fall back to the approved template outside the 24h window.
    const result = await deliverOutboundWhatsApp(supabase, {
      conversationId: conv.id,
      orgId: conv.org_id,
      channelId: channel.id,
      content,
      allowTemplateFallback: true,
      // WhatsApp carries one medium per message — send the first released file.
      ...(attached[0] ? { attachment: { storagePath: attached[0].storagePath } } : {}),
    });
    metadata = result.ok
      ? { whatsapp: { message_sid: result.externalId } }
      : { delivery: { failed: true, error: result.error } };
  }

  if (filesFailed) {
    metadata = { ...(metadata ?? {}), delivery: { ...(metadata?.delivery as object), files_failed: true } };
  }

  if (metadata) {
    await supabase
      .from('messages')
      .update({ metadata })
      .eq('org_id', conv.org_id)
      .eq('id', outboundId);
  }
}
