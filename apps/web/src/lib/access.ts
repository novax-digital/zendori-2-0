import 'server-only';
import { redirect } from 'next/navigation';
import {
  EMPTY_PERMISSIONS,
  LEGACY_AGENT_PERMISSIONS,
  allowedChannelIds,
  canAccessChannel,
  canEditArea,
  parseMemberPermissions,
  type AreaKey,
  type MemberAccess,
  type OrgRole,
} from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';

// Lightweight access loader for server ACTIONS (0024). Pages go through
// requireActiveOrg (which now carries `access`); actions receive the org id via
// form data and only need the caller's membership for THAT org — without the
// full membership/redirect dance.

/** The caller's access for one org, or null (not signed in / not a member). */
export async function getMemberAccess(orgId: string): Promise<MemberAccess | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // permissions is 0024 — retry without it while the migration is pending.
  let { data, error } = await supabase
    .from('org_members')
    .select('role, permissions')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (error && (error as { code?: string }).code === '42703') {
    ({ data, error } = await supabase
      .from('org_members')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', user.id)
      .maybeSingle());
  }
  if (error || !data) return null;
  const row = data as { role: OrgRole; permissions?: unknown };
  return {
    role: row.role,
    // Pre-0024 skew: agents keep their legacy full access instead of lockout.
    permissions:
      row.permissions === undefined
        ? row.role === 'agent'
          ? LEGACY_AGENT_PERMISSIONS
          : EMPTY_PERMISSIONS
        : parseMemberPermissions(row.permissions),
  };
}

/**
 * Conversation-scoped inbox guard (review 2026-07-23): inbox edit AND access to
 * the conversation's channel. The extra channel lookup only runs for
 * channel-scoped Mitarbeiter (admins and unscoped members take the fast path) —
 * without it, a scoped member could mutate conversations (status/assign/notes/
 * takeover) on channels their scope is supposed to hide.
 */
export async function hasConversationEdit(
  orgRaw: FormDataEntryValue | null | string,
  conversationIdRaw: FormDataEntryValue | null | string
): Promise<boolean> {
  const org = typeof orgRaw === 'string' ? orgRaw.trim() : '';
  const conversationId =
    typeof conversationIdRaw === 'string' ? conversationIdRaw.trim() : '';
  if (!org || !conversationId) return false;
  const access = await getMemberAccess(org);
  if (!access || !canEditArea(access, 'inbox')) return false;
  if (allowedChannelIds(access) === null) return true; // unscoped: no extra query
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('conversations')
    .select('channel_id')
    .eq('org_id', org)
    .eq('id', conversationId)
    .maybeSingle();
  const channelId = (data as { channel_id?: string } | null)?.channel_id;
  return typeof channelId === 'string' && canAccessChannel(access, channelId);
}

/** Non-redirecting variant for actions that return errors instead. */
export async function hasAreaEdit(
  orgRaw: FormDataEntryValue | null | string,
  area: AreaKey
): Promise<boolean> {
  const org = typeof orgRaw === 'string' ? orgRaw.trim() : '';
  if (!org) return false;
  const access = await getMemberAccess(org);
  return access !== null && canEditArea(access, area);
}

/**
 * Server-action guard: the caller must be allowed to EDIT `area` in the org.
 * Redirects to `deniedUrl` otherwise (matching each action's redirect style).
 */
export async function requireAreaEdit(
  orgRaw: FormDataEntryValue | null,
  area: AreaKey,
  deniedUrl: (org: string) => string
): Promise<MemberAccess> {
  const org = typeof orgRaw === 'string' ? orgRaw.trim() : '';
  const access = org ? await getMemberAccess(org) : null;
  if (!access || !canEditArea(access, area)) {
    redirect(deniedUrl(org || ''));
  }
  return access;
}
