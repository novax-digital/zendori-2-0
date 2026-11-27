import 'server-only';
import { canAccessChannel, canViewArea, type SupabaseClient } from '@zendori/core';
import { getMemberAccess } from '@/lib/access';
import { findWidgetChannelByToken } from '@/lib/widget/session';

// Test mode of the widget API (migration 0050, docs/webchat-test.md).
//
// The tab "Test" of a chat channel embeds the REAL widget, with one extra
// attribute (data-zendori-test). The widget then sends `test: true` with every
// call, and the three routes resolve the channel through here instead of the
// public lookup. Two things change in that mode:
//
//   · an inactive channel (a draft) answers too, and
//   · the conversation it starts is marked as a test (conversations.is_test).
//
// Both are only for a signed-in member of the channel's organization: the
// widget runs on Zendori's own origin there, so the request carries the
// member's session cookie. A visitor on a customer website has none — a
// request from there that claims `test: true` gets the same answer as an
// unknown token. (Cross-origin calls are sent without cookies: the widget API
// allows any origin, but never credentials.)

export type WidgetChannel = NonNullable<Awaited<ReturnType<typeof findWidgetChannelByToken>>>;

/**
 * The widget channel behind `token` for a call in test mode, or null when the
 * token is unknown or the caller is not a member who may see this channel.
 * Throws WidgetDbError like the public lookup.
 */
export async function findWidgetChannelForTest(
  admin: SupabaseClient,
  token: string
): Promise<WidgetChannel | null> {
  const channel = await findWidgetChannelByToken(admin, token, { includeInactive: true });
  if (!channel) return null;
  const access = await getMemberAccess(channel.org_id);
  if (!access) return null;
  if (!canViewArea(access, 'channels') || !canAccessChannel(access, channel.id)) return null;
  return channel;
}
