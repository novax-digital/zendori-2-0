/**
 * Shared types for the embeddable chat widget.
 * This code is bundled standalone (esbuild → public/widget.js) and runs in the
 * browser of arbitrary customer websites — keep it framework-free and lean.
 */

// The theme model is shared with the server and the designer:
// packages/channels/src/chat/theme.ts (dependency-free on purpose).
export type { WidgetTheme } from '@zendori/channels/chat-theme';

export type RealtimeConfig = {
  url: string;
  anonKey: string;
};

export type BootstrapResponse = {
  /** As stored for the channel — the widget normalizes it before use. */
  theme: unknown;
  realtime: RealtimeConfig;
};

/** One message as returned by the session history and the broadcast trigger. */
export type HistoryMessage = {
  id: string;
  content: string;
  content_type: string;
  sender_type: string;
  created_at: string;
};

export type SessionResponse = {
  conversationId: string;
  /** Empty string when the server does not echo a secret (valid resume). */
  secret: string;
  topic: string;
  messages: HistoryMessage[];
};

export type StoredSession = {
  conversationId: string;
  secret: string;
};

export type ContactDetails = {
  name?: string;
  email?: string;
};

export type WidgetConfig = {
  token: string;
  apiBase: string;
  /**
   * Set by data-zendori-test on Zendori's own "Test" tab (0050): the API then
   * answers for a draft channel too and marks the conversation as a test. It
   * only works for a signed-in member — on a customer website the attribute
   * makes the widget stay invisible.
   */
  test: boolean;
};
