import { RealtimeClient } from '@supabase/supabase-js';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { HistoryMessage, RealtimeConfig } from './types';

export type ReplyHandler = (message: HistoryMessage) => void;

/** Parses the payload sent by the DB broadcast trigger for outbound messages. */
function parseReply(value: unknown): HistoryMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.content !== 'string') return null;
  return {
    id: record.id,
    content: record.content,
    content_type: typeof record.content_type === 'string' ? record.content_type : 'text',
    sender_type: typeof record.sender_type === 'string' ? record.sender_type : '',
    created_at: typeof record.created_at === 'string' ? record.created_at : '',
  };
}

/** Builds the realtime websocket endpoint the same way supabase-js does. */
function realtimeEndpoint(supabaseUrl: string): string {
  const url = new URL('realtime/v1', supabaseUrl.endsWith('/') ? supabaseUrl : `${supabaseUrl}/`);
  url.protocol = url.protocol.replace('http', 'ws');
  return url.href;
}

/**
 * Manages the realtime broadcast subscription for one widget session topic.
 * Uses RealtimeClient directly (instead of the full supabase-js createClient)
 * to keep the widget bundle small; the wire behavior for an unauthenticated
 * public broadcast channel is identical. The client reconnects the underlying
 * socket on its own and Phoenix auto-rejoins live channels, so repeated
 * `subscribe` calls with the same topic are a no-op; only a topic CHANGE
 * tears down the old channel and joins the new one.
 */
export class RealtimeConnection {
  private client: RealtimeClient | null = null;
  private channel: RealtimeChannel | null = null;
  private topic: string | null = null;

  constructor(
    private readonly config: RealtimeConfig,
    private readonly onReply: ReplyHandler
  ) {}

  subscribe(topic: string): void {
    if (!this.client) {
      this.client = new RealtimeClient(realtimeEndpoint(this.config.url), {
        params: { apikey: this.config.anonKey },
      });
      // Same channel access token an unauthenticated supabase-js client sends.
      void this.client.setAuth(this.config.anonKey);
    }
    const client = this.client;
    const existing = this.channel;
    // same topic, channel still alive → nothing to do (auto-rejoin covers
    // reconnects, history reloads cover missed replies)
    if (existing && this.topic === topic && existing.state !== 'closed') return;
    this.channel = null;
    this.topic = topic;
    const join = (): void => {
      // a newer subscribe() may have taken over while the old channel closed
      if (this.topic !== topic || this.channel) return;
      this.channel = client
        .channel(topic, { config: { broadcast: { self: false } } })
        .on('broadcast', { event: 'reply' }, (message) => {
          const parsed = parseReply((message as { payload?: unknown }).payload);
          if (parsed) this.onReply(parsed);
        })
        .subscribe();
    };
    if (existing) {
      // create the new channel only AFTER the old one is fully removed
      void client.removeChannel(existing).finally(join);
    } else {
      join();
    }
  }
}
