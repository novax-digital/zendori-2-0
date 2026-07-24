import { describe, expect, it } from 'vitest';
import {
  AREA_DEFS,
  allowedChannelIds,
  canAccessChannel,
  canEditArea,
  canViewArea,
  isAdminRole,
  parseMemberPermissions,
  type MemberAccess,
} from '../src/permissions.js';

const agentAccess = (areas: Record<string, string>, channelIds: string[] | null): MemberAccess => ({
  role: 'agent',
  permissions: parseMemberPermissions({ areas, channelIds }),
});

describe('parseMemberPermissions', () => {
  it('parses a valid shape', () => {
    const p = parseMemberPermissions({
      areas: { inbox: 'edit', knowledge: 'view' },
      channelIds: null,
    });
    expect(p.areas.inbox).toBe('edit');
    expect(p.areas.knowledge).toBe('view');
    expect(p.channelIds).toBeNull();
  });

  it('grants nothing on junk input (fail closed)', () => {
    for (const raw of [null, undefined, 'x', 42, [], { areas: 'nope', channelIds: 'alle' }]) {
      const p = parseMemberPermissions(raw);
      expect(Object.keys(p.areas)).toHaveLength(0);
      expect(p.channelIds).toBeNull();
    }
  });

  it('strips invalid area levels per key instead of failing the whole object', () => {
    const p = parseMemberPermissions({
      areas: { inbox: 'superuser', canned: 'view' },
      channelIds: null,
    });
    expect(p.areas.inbox).toBeUndefined();
    expect(p.areas.canned).toBe('view');
  });
});

describe('role + area helpers', () => {
  it('owner and admin bypass all area checks', () => {
    for (const role of ['owner', 'admin'] as const) {
      const access: MemberAccess = { role, permissions: parseMemberPermissions({}) };
      expect(isAdminRole(role)).toBe(true);
      expect(canViewArea(access, 'billing')).toBe(true);
      expect(canEditArea(access, 'agents')).toBe(true);
      expect(allowedChannelIds(access)).toBeNull();
    }
  });

  it('agents need explicit grants; view does not imply edit', () => {
    const access = agentAccess({ knowledge: 'view', inbox: 'edit' }, null);
    expect(canViewArea(access, 'knowledge')).toBe(true);
    expect(canEditArea(access, 'knowledge')).toBe(false);
    expect(canEditArea(access, 'inbox')).toBe(true);
    expect(canViewArea(access, 'billing')).toBe(false);
  });

  it('channel scope: null = all, list = only listed', () => {
    const unrestricted = agentAccess({ inbox: 'edit' }, null);
    expect(canAccessChannel(unrestricted, 'any-id')).toBe(true);

    const id = '4c9f2f1a-9d2b-4f6e-8a0e-1c2d3e4f5a6b';
    const scoped = agentAccess({ inbox: 'edit' }, [id]);
    expect(canAccessChannel(scoped, id)).toBe(true);
    expect(canAccessChannel(scoped, '9c9f2f1a-9d2b-4f6e-8a0e-1c2d3e4f5a6b')).toBe(false);
    expect(allowedChannelIds(scoped)).toEqual([id]);
  });

  it('AREA_DEFS caps DB-owner-gated areas at view', () => {
    const byKey = new Map(AREA_DEFS.map((d) => [d.key, d.maxLevel]));
    expect(byKey.get('agents')).toBe('view');
    expect(byKey.get('channels')).toBe('view');
    expect(byKey.get('handoff')).toBe('view');
    expect(byKey.get('inbox')).toBe('edit');
    expect(byKey.get('knowledge')).toBe('edit');
  });
});
