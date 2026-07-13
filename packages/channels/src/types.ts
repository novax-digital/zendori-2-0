import type { ChannelType, ContentType } from '@zendori/core';
import type { ChannelConfig } from './config.js';

/** Normalized inbound message — every channel webhook/ingest payload maps to this. */
export interface UnifiedInboundMessage {
  channelType: ChannelType;
  /** Provider-side id used for idempotency (unique per channel); null if the provider has none. */
  externalId: string | null;
  contact: {
    name?: string;
    email?: string;
    phone?: string;
    waId?: string;
  };
  content: string;
  contentType: ContentType;
  /** Threading reference, e.g. email In-Reply-To / References. */
  threadRef?: string;
  receivedAt: string;
  metadata: Record<string, unknown>;
}

/** Outbound message sent from the inbox (agent) or by the bot. */
export interface OutboundMessage {
  conversationId: string;
  content: string;
  contentType: ContentType;
  /** Recipient info the adapter needs (email address, wa_id, chat session, …). */
  to: {
    email?: string;
    phone?: string;
    waId?: string;
    sessionId?: string;
  };
  /** Threading reference for replies (e.g. Message-ID of the mail being answered). */
  threadRef?: string;
  metadata?: Record<string, unknown>;
}

export interface SendResult {
  /** Provider-side id of the sent message, if available. */
  externalId: string | null;
  raw?: unknown;
}

export interface ChannelAdapter {
  type: ChannelType;
  /** Webhook/ingest payload → normalized message. Throws on invalid payloads (zod). */
  normalize(raw: unknown): UnifiedInboundMessage;
  /** Send a reply from the inbox / the bot through this channel. */
  send(msg: OutboundMessage, channelConfig: ChannelConfig): Promise<SendResult>;
}
