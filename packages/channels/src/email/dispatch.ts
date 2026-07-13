import { z } from 'zod';
import type { SupabaseClient } from '@zendori/core';
import { buildReplySubject } from './mail-text.js';
import { sendEmail } from './send.js';

/**
 * Minimal boundary validation of an inbound-email channel config. The shape
 * mirrors emailInboundConfigSchema; only address + senderDomain are needed here.
 */
const inboundEmailConfigSchema = z.object({
  mode: z.literal('inbound'),
  address: z.email(),
  senderDomain: z.string().min(1).optional(),
});

export type DeliverOutboundResult = { ok: true; messageId: string } | { ok: false; error: string };

/**
 * Sends an agent/bot reply out through an inbound-email channel via Resend.
 * Resolves the recipient (conversation contact), threading headers (newest
 * inbound email of the conversation) and the sender address, then delegates to
 * the Resend client which sets and returns the outbound RFC Message-ID.
 * Never logs message content or recipient addresses (GDPR, §7).
 *
 * Used from apps/web (agent reply, Phase 3) and apps/worker (bot auto-send +
 * auto-ack, Phase 5) — both pass a service-role Supabase client.
 */
export async function deliverOutboundEmail(
  supabase: SupabaseClient,
  params: { conversationId: string; orgId: string; channelId: string; content: string }
): Promise<DeliverOutboundResult> {
  const { conversationId, orgId, channelId, content } = params;

  // 1. channel must be an inbound-email channel; read its intake address
  const { data: channelRow } = await supabase
    .from('channels')
    .select('type, config')
    .eq('org_id', orgId)
    .eq('id', channelId)
    .maybeSingle();
  const channel = channelRow as { type: string; config: Record<string, unknown> } | null;
  if (!channel || channel.type !== 'email') {
    return { ok: false, error: 'Der Kanal unterstützt keinen E-Mail-Versand.' };
  }
  const config = inboundEmailConfigSchema.safeParse(channel.config);
  if (!config.success) {
    return { ok: false, error: 'Der Kanal unterstützt keinen E-Mail-Versand.' };
  }
  const intakeAddress = config.data.address;

  // 2. sender: verified customer domain if configured, else the Zendori fallback
  const resendFrom = process.env.RESEND_FROM;
  const from = config.data.senderDomain ? `support@${config.data.senderDomain}` : resendFrom;
  if (!from) {
    return {
      ok: false,
      error: 'E-Mail-Versand ist noch nicht konfiguriert (Absenderdomain fehlt).',
    };
  }

  // 3. recipient + subject from the conversation's contact
  const { data: convRow } = await supabase
    .from('conversations')
    .select('subject, contact_id')
    .eq('org_id', orgId)
    .eq('id', conversationId)
    .maybeSingle();
  const conversation = convRow as { subject: string | null; contact_id: string | null } | null;
  if (!conversation || !conversation.contact_id) {
    return { ok: false, error: 'Empfänger konnte nicht ermittelt werden.' };
  }

  const { data: contactRow } = await supabase
    .from('contacts')
    .select('email')
    .eq('org_id', orgId)
    .eq('id', conversation.contact_id)
    .maybeSingle();
  const contactEmail = (contactRow as { email: string | null } | null)?.email;
  if (!contactEmail) {
    return { ok: false, error: 'Der Kontakt hat keine E-Mail-Adresse für den Versand.' };
  }

  // 4. threading: reference the newest inbound email of this conversation and
  //    rebuild the full References chain (its prior refs + its own message-id).
  const { data: inboundRows } = await supabase
    .from('messages')
    .select('metadata')
    .eq('org_id', orgId)
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(10);
  const rows = (inboundRows ?? []) as {
    metadata: { email?: { message_id?: unknown; references?: unknown } };
  }[];
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  for (const row of rows) {
    const email = row.metadata?.email;
    const id = email?.message_id;
    if (typeof id === 'string' && id.length > 0) {
      inReplyTo = id;
      const chain: string[] = [];
      if (Array.isArray(email?.references)) {
        for (const ref of email.references) {
          if (typeof ref === 'string' && ref.length > 0) chain.push(ref);
        }
      }
      chain.push(id);
      references = Array.from(new Set(chain)); // dedupe, keep chronological order
      break;
    }
  }

  // 5. dispatch — sendEmail sets and returns the outbound Message-ID for threading
  try {
    const result = await sendEmail({
      from,
      to: contactEmail,
      replyTo: intakeAddress,
      subject: buildReplySubject(conversation.subject),
      text: content,
      inReplyTo,
      references,
    });
    return { ok: true, messageId: result.messageId };
  } catch {
    // no content or recipient in logs; the caller records the failure on the message
    return { ok: false, error: 'E-Mail konnte nicht versendet werden.' };
  }
}
