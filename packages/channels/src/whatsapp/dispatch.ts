import { decryptSecret, type SupabaseClient } from '@zendori/core';
import { whatsappChannelConfigSchema } from '../config.js';
import { isWithinServiceWindow } from './service-window.js';
import { sendTwilioWhatsApp } from './twilio/send.js';

// Inbox/worker-facing WhatsApp send entry point. Mirrors deliverOutboundEmail:
// loads the channel config, resolves the recipient + 24h service window, then
// dispatches to the provider backend. Never throws to the caller and never logs
// the token, recipient or content (§7).

export type WhatsAppDeliverResult =
  | { ok: true; externalId: string }
  | { ok: false; error: string };

export interface DeliverOutboundWhatsAppParams {
  conversationId: string;
  orgId: string;
  channelId: string;
  content: string;
  /**
   * Bot/system re-engagement may fall back to the approved template when the 24h
   * window is closed. Agent replies pass false: outside the window we return an
   * error instead of silently sending a generic template in place of their text.
   */
  allowTemplateFallback?: boolean;
}

function masterKey(): string | null {
  const key = process.env.MASTER_ENCRYPTION_KEY;
  return key && key.length > 0 ? key : null;
}

/** Resolves the recipient "+E164" from the conversation's contact (wa_id preferred). */
async function resolveRecipient(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('contacts')
    .select('wa_id, phone')
    .eq('org_id', orgId)
    .eq('id', contactId)
    .maybeSingle();
  const contact = data as { wa_id: string | null; phone: string | null } | null;
  if (!contact) return null;
  if (contact.wa_id && contact.wa_id.length > 0) {
    return contact.wa_id.startsWith('+') ? contact.wa_id : `+${contact.wa_id}`;
  }
  if (contact.phone && contact.phone.startsWith('+')) return contact.phone;
  return null;
}

/** Timestamp of the newest inbound message of this conversation (window basis). */
async function resolveLastInboundAt(
  supabase: SupabaseClient,
  orgId: string,
  conversationId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('messages')
    .select('created_at')
    .eq('org_id', orgId)
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}

export async function deliverOutboundWhatsApp(
  supabase: SupabaseClient,
  params: DeliverOutboundWhatsAppParams
): Promise<WhatsAppDeliverResult> {
  const { conversationId, orgId, channelId, content, allowTemplateFallback = false } = params;

  const key = masterKey();
  if (!key) return { ok: false, error: 'Verschlüsselung ist serverseitig nicht konfiguriert.' };

  // 1. channel + config
  const { data: channelRow } = await supabase
    .from('channels')
    .select('type, config')
    .eq('org_id', orgId)
    .eq('id', channelId)
    .maybeSingle();
  const channel = channelRow as { type: string; config: unknown } | null;
  if (!channel || channel.type !== 'whatsapp') {
    return { ok: false, error: 'Der Kanal unterstützt keinen WhatsApp-Versand.' };
  }
  const configResult = whatsappChannelConfigSchema.safeParse(channel.config);
  if (!configResult.success) {
    return { ok: false, error: 'Die WhatsApp-Konfiguration ist ungültig.' };
  }
  const config = configResult.data;

  // 2. recipient
  const { data: convRow } = await supabase
    .from('conversations')
    .select('contact_id')
    .eq('org_id', orgId)
    .eq('id', conversationId)
    .maybeSingle();
  const contactId = (convRow as { contact_id: string | null } | null)?.contact_id;
  if (!contactId) return { ok: false, error: 'Empfänger konnte nicht ermittelt werden.' };
  const to = await resolveRecipient(supabase, orgId, contactId);
  if (!to) return { ok: false, error: 'Der Kontakt hat keine WhatsApp-Nummer für den Versand.' };

  // 3. 24h service window → freeform vs. approved template
  const lastInboundAt = await resolveLastInboundAt(supabase, orgId, conversationId);
  const inWindow = isWithinServiceWindow(lastInboundAt);
  const template = config.fallbackServiceTemplate;
  // A template is only usable if it carries the identifier the provider needs to
  // actually send it — for Twilio the approved ContentSid. A name-only template
  // must NOT let the guard pass and then fall through to (doomed) freeform.
  const usableTemplate =
    config.provider === 'twilio' ? (template?.twilioContentSid ? template : undefined) : template;
  if (!inWindow && !(allowTemplateFallback && usableTemplate)) {
    return {
      ok: false,
      error:
        'Außerhalb des 24-Stunden-Fensters — freier Text ist nicht zustellbar. Ein genehmigtes Template ist nötig.',
    };
  }

  // 4. provider dispatch
  if (config.provider === 'twilio') {
    let authToken: string;
    try {
      authToken = await decryptSecret(config.authTokenEncrypted, key);
    } catch {
      return { ok: false, error: 'Das Twilio-Token konnte nicht entschlüsselt werden.' };
    }
    try {
      const sendParams: Parameters<typeof sendTwilioWhatsApp>[0] = {
        accountSid: config.accountSid,
        authToken,
        to,
      };
      if (config.messagingServiceSid) sendParams.messagingServiceSid = config.messagingServiceSid;
      else sendParams.sender = config.sender;

      if (!inWindow && template?.twilioContentSid) {
        sendParams.contentSid = template.twilioContentSid;
      } else {
        sendParams.body = content;
      }
      const { sid } = await sendTwilioWhatsApp(sendParams);
      return { ok: true, externalId: sid };
    } catch {
      return { ok: false, error: 'WhatsApp konnte nicht versendet werden.' };
    }
  }

  // config.provider === 'meta' — built in Phase 7b
  return { ok: false, error: 'WhatsApp über Meta ist noch nicht aktiv (Phase 7b).' };
}
