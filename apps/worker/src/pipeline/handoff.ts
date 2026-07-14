// Autopilot + human-handoff decision helpers for the Phase-5 worker pipeline
// (CLAUDE.md §6, §4 message-flow). detectHandoff / decideDraftAction /
// isAutopilotEnabled are pure and unit-tested; deliverBotReply performs the
// outbound persist + channel delivery. Message content is never logged (§7).
import { deliverOutboundEmail, deliverOutboundWhatsApp } from '@zendori/channels';
import type { ChannelType, HandoffReason, SupabaseClient } from '@zendori/core';

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
}

export interface DetectHandoffResult {
  handoff: boolean;
  reason: HandoffReason | null;
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
    return { handoff: true, reason: 'keyword' };
  }
  if (input.wantsHuman) {
    return { handoff: true, reason: 'user_request' };
  }
  if (input.confidence < input.threshold) {
    return { handoff: true, reason: 'low_confidence' };
  }
  return { handoff: false, reason: null };
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
 * Gate the drafted reply (§4 message-flow): a required handoff always wins;
 * otherwise auto-send only when the org enabled autopilot for this channel;
 * else keep the draft as a suggestion (Phase-4 behaviour). Pure.
 */
export function decideDraftAction(handoff: boolean, autopilotEnabled: boolean): DraftAction {
  if (handoff) return 'handoff';
  if (autopilotEnabled) return 'auto_send';
  return 'pending';
}

/**
 * Read org_settings.autopilot_enabled ({"chat": true, "email": false, …}) for a
 * channel type. Only a strict boolean true enables it; missing/non-object/other
 * values mean off. Pure.
 */
export function isAutopilotEnabled(autopilotEnabled: unknown, channelType: ChannelType): boolean {
  if (
    autopilotEnabled !== null &&
    typeof autopilotEnabled === 'object' &&
    !Array.isArray(autopilotEnabled)
  ) {
    return (autopilotEnabled as Record<string, unknown>)[channelType] === true;
  }
  return false;
}

// --- outbound delivery -------------------------------------------------------

export interface DeliverBotReplyParams {
  conv: { id: string; org_id: string };
  channel: { id: string; type: ChannelType };
  content: string;
  /** 'bot' for auto-sent answers, 'system' for auto-ack notices (§6). */
  senderType: 'bot' | 'system';
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

  // Email and WhatsApp actually deliver; both record the outcome on the row and
  // never throw. Chat/Voice persist only.
  let metadata: Record<string, unknown> | null = null;
  if (channel.type === 'email') {
    const result = await deliverOutboundEmail(supabase, {
      conversationId: conv.id,
      orgId: conv.org_id,
      channelId: channel.id,
      content,
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
    });
    metadata = result.ok
      ? { whatsapp: { message_sid: result.externalId } }
      : { delivery: { failed: true, error: result.error } };
  }

  if (metadata) {
    await supabase
      .from('messages')
      .update({ metadata })
      .eq('org_id', conv.org_id)
      .eq('id', outboundId);
  }
}
