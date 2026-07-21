import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@zendori/core';

// --- types & defaults -----------------------------------------------------------

export type WidgetTheme = { color: string; title: string; greeting: string };

export type WidgetChannelConfig = {
  widget: true;
  public_token: string;
  theme: WidgetTheme;
  /** Ticket separation: hours of inactivity after which a returning visitor
   *  starts a new conversation (rotation on resume). Absent = never split. */
  conversation_split_hours?: number;
};

export const DEFAULT_THEME: WidgetTheme = {
  color: '#4f46e5',
  title: 'Support',
  greeting: 'Hallo! Wie können wir helfen?',
};

/** channels.config shape for widget channels — tolerates a missing/partial theme. */
const widgetChannelConfigSchema = z.object({
  widget: z.literal(true),
  public_token: z.string().min(1),
  theme: z
    .object({
      color: z.string().default(DEFAULT_THEME.color),
      title: z.string().default(DEFAULT_THEME.title),
      greeting: z.string().default(DEFAULT_THEME.greeting),
    })
    .default(DEFAULT_THEME),
  conversation_split_hours: z.number().int().min(1).max(8760).optional(),
});

/**
 * Thrown when a widget lookup fails because of a database error — as opposed
 * to "not found". Routes catch this and answer 503 (with CORS headers) so a
 * transient DB problem is never mistaken for an unknown token/session.
 */
export class WidgetDbError extends Error {
  constructor(context: string) {
    super(`Widget DB query failed: ${context}`);
    this.name = 'WidgetDbError';
  }
}

// --- token / secret helpers ------------------------------------------------------

/** Public widget token (32 hex) — identifies the channel, not a credential. */
export function generatePublicToken(): string {
  return randomBytes(16).toString('hex');
}

/** Per-session secret (48 hex) — sent to the browser once, stored only as hash. */
export function generateSessionSecret(): string {
  return randomBytes(24).toString('hex');
}

/** sha256 hex of a session secret — only the hash is persisted. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison of two hash strings. */
function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// --- service-role lookups ---------------------------------------------------------

/**
 * Resolves a public widget token to its active widget channel.
 * Returns null for unknown tokens, inactive channels or non-widget configs;
 * throws WidgetDbError on database errors.
 */
export async function findWidgetChannelByToken(
  admin: SupabaseClient,
  token: string
): Promise<{ id: string; org_id: string; config: WidgetChannelConfig } | null> {
  const { data, error } = await admin
    .from('channels')
    .select('id, org_id, config')
    .eq('type', 'chat')
    .eq('is_active', true)
    .contains('config', { widget: true, public_token: token })
    .limit(1);
  if (error) throw new WidgetDbError('channels lookup');
  const row = (data ?? [])[0] as { id: string; org_id: string; config: unknown } | undefined;
  if (!row) return null;
  const parsed = widgetChannelConfigSchema.safeParse(row.config);
  if (!parsed.success || parsed.data.public_token !== token) return null;
  return { id: row.id, org_id: row.org_id, config: parsed.data };
}

/**
 * Verifies a widget session by conversation id + secret (sha256 compare).
 * When the conversation id no longer resolves (the session was rotated onto a
 * new conversation by ticket separation), the session is found via the secret
 * hash instead — the returned session.conversation_id is therefore the
 * AUTHORITATIVE current conversation, which may differ from the id the client
 * sent. The caller must additionally check session.channel_id against the
 * channel resolved from the public token (token → channel → session chain).
 * Returns null for unknown sessions or wrong secrets; throws WidgetDbError
 * on database errors.
 */
export async function verifySession(
  admin: SupabaseClient,
  conversationId: string,
  secret: string
): Promise<{
  session: {
    id: string;
    org_id: string;
    channel_id: string;
    conversation_id: string;
    contact_id: string | null;
  };
  /** Conversation state for the ticket-separation check on resume. */
  conversation: { status: string; lastMessageAt: string | null };
} | null> {
  type SessionRow = {
    id: string;
    org_id: string;
    channel_id: string;
    conversation_id: string;
    secret_hash: string;
  };
  const providedHash = hashSecret(secret);

  const { data, error } = await admin
    .from('widget_sessions')
    .select('id, org_id, channel_id, conversation_id, secret_hash')
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (error) throw new WidgetDbError('widget_sessions lookup');
  let row = data as SessionRow | null;

  if (!row) {
    // Ticket separation may have rotated the session away from the id this
    // client stored. The 192-bit random secret itself identifies the session:
    // fall back to a lookup by its hash so stale tabs / lost rotation
    // responses converge on the CURRENT conversation instead of expiring.
    const { data: bySecret, error: bySecretError } = await admin
      .from('widget_sessions')
      .select('id, org_id, channel_id, conversation_id, secret_hash')
      .eq('secret_hash', providedHash)
      .limit(1);
    if (bySecretError) throw new WidgetDbError('widget_sessions secret lookup');
    row = ((bySecret ?? [])[0] as SessionRow | undefined) ?? null;
    if (!row) return null;
  }
  if (!hashesMatch(providedHash, row.secret_hash)) return null;

  const { data: conversationRow, error: conversationError } = await admin
    .from('conversations')
    .select('contact_id, status, last_message_at')
    .eq('id', row.conversation_id)
    .maybeSingle();
  if (conversationError) throw new WidgetDbError('conversations lookup');
  const conversation = conversationRow as {
    contact_id: string | null;
    status: string | null;
    last_message_at: string | null;
  } | null;

  return {
    session: {
      id: row.id,
      org_id: row.org_id,
      channel_id: row.channel_id,
      conversation_id: row.conversation_id,
      contact_id: conversation?.contact_id ?? null,
    },
    conversation: {
      status: conversation?.status ?? 'open',
      lastMessageAt: conversation?.last_message_at ?? null,
    },
  };
}
