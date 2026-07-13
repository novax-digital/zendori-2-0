/**
 * Shared types for the embeddable chat widget.
 * This code is bundled standalone (esbuild → public/widget.js) and runs in the
 * browser of arbitrary customer websites — keep it framework-free and lean.
 */

export type WidgetTheme = {
  color: string;
  title: string;
  greeting: string;
};

export type RealtimeConfig = {
  url: string;
  anonKey: string;
};

export type BootstrapResponse = {
  theme: WidgetTheme;
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
};
