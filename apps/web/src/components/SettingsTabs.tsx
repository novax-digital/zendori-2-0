// Tab bar for the consolidated "Einstellungen" hub (nav restructure 2026-07-24):
// the individual pages keep their routes/guards; this bar just links between
// them. Server component — the active tab is passed in, tabs the member may not
// view are hidden (pages still guard authoritatively).
import Link from 'next/link';
import { canViewArea, isAdminRole, type MemberAccess } from '@zendori/core';

export type SettingsTabKey =
  | 'organization'
  | 'phone-numbers'
  | 'ai'
  | 'canned-responses'
  | 'integrations'
  | 'billing';

const TABS: { key: SettingsTabKey; href: string; label: string }[] = [
  { key: 'organization', href: '/settings/organization', label: 'Organisation' },
  { key: 'phone-numbers', href: '/settings/phone-numbers', label: 'Telefonnummern' },
  { key: 'ai', href: '/settings/ai', label: 'Übergabe & Zeiten' },
  { key: 'canned-responses', href: '/settings/canned-responses', label: 'Textbausteine' },
  { key: 'integrations', href: '/settings/integrations', label: 'Integrationen' },
  { key: 'billing', href: '/settings/billing', label: 'Abrechnung' },
];

export function settingsTabVisible(access: MemberAccess, key: SettingsTabKey): boolean {
  switch (key) {
    case 'organization':
    case 'integrations':
      return isAdminRole(access.role);
    case 'phone-numbers':
      return canViewArea(access, 'channels');
    case 'ai':
      return canViewArea(access, 'handoff');
    case 'canned-responses':
      return canViewArea(access, 'canned');
    case 'billing':
      return canViewArea(access, 'billing');
  }
}

/** First tab this member may open (the /settings index redirect target). */
export function firstVisibleSettingsTab(access: MemberAccess): string | null {
  const tab = TABS.find((t) => settingsTabVisible(access, t.key));
  return tab ? tab.href : null;
}

export default function SettingsTabs({
  active,
  access,
  orgId,
}: {
  active: SettingsTabKey;
  access: MemberAccess;
  orgId: string;
}) {
  const visible = TABS.filter((t) => settingsTabVisible(access, t.key));
  if (visible.length <= 1) return null;
  return (
    <div className="tabbar" style={{ marginBottom: '1.25rem' }}>
      {visible.map((tab) => (
        <Link
          key={tab.key}
          href={`${tab.href}?org=${orgId}`}
          className={`tab${tab.key === active ? ' tab--active' : ''}`}
          style={{ textDecoration: 'none' }}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
