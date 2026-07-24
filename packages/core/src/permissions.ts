import { z } from 'zod';
import type { OrgRole } from './schemas.js';

// Team roles + granular member permissions (migration 0024, modeled after the
// App-Control team system the owner likes). Three roles per org:
//   owner  — the account owner (created by the platform admin); full rights,
//            cannot be demoted/removed by admins, only owners delete the org.
//   admin  — full rights ("kann alles editieren"); DB-side via the extended
//            private.is_org_owner() so every owner-gated policy/trigger applies.
//   agent  — "Mitarbeiter": sees/edits only what its permissions grant.
//
// Permissions live as jsonb on org_members: which AREAS the member may view or
// edit, plus which channels their inbox covers (null = all channels — the
// App-Control "Standorte" analogue). Enforcement is app-level (nav gating, page
// guards, server-action guards, inbox channel filter); RLS keeps enforcing org
// isolation and the owner/admin write gates. Fine-grained per-permission RLS is
// a documented later step (docs/team.md).

export type { OrgRole } from './schemas.js';

export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
  owner: 'Inhaber',
  admin: 'Admin',
  agent: 'Mitarbeiter',
};

export type AreaLevel = 'view' | 'edit';

/** Feature areas a Mitarbeiter can be granted access to (the chips). */
export const AREA_KEYS = [
  'inbox',
  'knowledge',
  'canned',
  'agents',
  'channels',
  'handoff',
  'billing',
] as const;
export type AreaKey = (typeof AREA_KEYS)[number];

export interface AreaDef {
  key: AreaKey;
  label: string;
  /**
   * Highest level grantable to a Mitarbeiter. Areas whose writes are
   * owner/admin-gated in the DB (agents, channels/forms, org_settings) cap at
   * 'view' — "Bearbeiten" there is admin+ by design AND by RLS.
   */
  maxLevel: AreaLevel;
}

export const AREA_DEFS: AreaDef[] = [
  { key: 'inbox', label: 'Posteingang', maxLevel: 'edit' },
  { key: 'knowledge', label: 'Wissensdatenbank', maxLevel: 'edit' },
  { key: 'canned', label: 'Textbausteine', maxLevel: 'edit' },
  { key: 'agents', label: 'KI-Agenten', maxLevel: 'view' },
  { key: 'channels', label: 'Kanäle & Formulare', maxLevel: 'view' },
  { key: 'handoff', label: 'Übergabe & Zeiten', maxLevel: 'view' },
  { key: 'billing', label: 'Abrechnung', maxLevel: 'view' },
];

const areaLevelSchema = z.enum(['view', 'edit']);

/** org_members.permissions / invites.permissions jsonb shape. */
export const memberPermissionsSchema = z.object({
  /** Absent area ⇒ no access. */
  areas: z
    .object({
      inbox: areaLevelSchema.optional().catch(undefined),
      knowledge: areaLevelSchema.optional().catch(undefined),
      canned: areaLevelSchema.optional().catch(undefined),
      agents: areaLevelSchema.optional().catch(undefined),
      channels: areaLevelSchema.optional().catch(undefined),
      handoff: areaLevelSchema.optional().catch(undefined),
      billing: areaLevelSchema.optional().catch(undefined),
    })
    .partial()
    .catch({}),
  /** Inbox channel scope: null = all channels (incl. future ones). */
  channelIds: z.array(z.uuid()).nullable().catch(null),
});

export interface MemberPermissions {
  areas: Partial<Record<AreaKey, AreaLevel>>;
  channelIds: string[] | null;
}

export const EMPTY_PERMISSIONS: MemberPermissions = { areas: {}, channelIds: null };

/**
 * What a pre-0024 'agent' could effectively do (full member access, settings
 * read-only, no billing). Used to BACKFILL existing agent rows in migration
 * 0024 and as the 42703 skew fallback — without it, every existing Mitarbeiter
 * would be locked out the moment the permission gating ships (review
 * 2026-07-23).
 */
export const LEGACY_AGENT_PERMISSIONS: MemberPermissions = {
  areas: {
    inbox: 'edit',
    knowledge: 'edit',
    canned: 'edit',
    agents: 'view',
    channels: 'view',
    handoff: 'view',
  },
  channelIds: null,
};

/** Tolerant jsonb → MemberPermissions (unknown/invalid input ⇒ no access granted). */
export function parseMemberPermissions(raw: unknown): MemberPermissions {
  const parsed = memberPermissionsSchema.safeParse(raw ?? {});
  if (!parsed.success) return EMPTY_PERMISSIONS;
  return {
    areas: (parsed.data.areas ?? {}) as Partial<Record<AreaKey, AreaLevel>>,
    channelIds: parsed.data.channelIds ?? null,
  };
}

/** A member's effective access: role + parsed permissions. */
export interface MemberAccess {
  role: OrgRole;
  permissions: MemberPermissions;
}

/** Owner and admin are full-rights roles. */
export function isAdminRole(role: OrgRole): boolean {
  return role === 'owner' || role === 'admin';
}

export function canViewArea(access: MemberAccess, area: AreaKey): boolean {
  if (isAdminRole(access.role)) return true;
  return access.permissions.areas[area] !== undefined;
}

export function canEditArea(access: MemberAccess, area: AreaKey): boolean {
  if (isAdminRole(access.role)) return true;
  return access.permissions.areas[area] === 'edit';
}

/**
 * The channel ids this member's inbox is scoped to. null = unrestricted.
 * Admin roles are never scoped.
 */
export function allowedChannelIds(access: MemberAccess): string[] | null {
  if (isAdminRole(access.role)) return null;
  return access.permissions.channelIds;
}

/** May this member's inbox show the given channel? */
export function canAccessChannel(access: MemberAccess, channelId: string): boolean {
  const allowed = allowedChannelIds(access);
  return allowed === null || allowed.includes(channelId);
}
