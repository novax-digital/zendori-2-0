// Frame of the "Einstellungen" hub (redesign stage 6, page type D): the
// sub-navigation on the left over the full height, the page itself — a normal
// page with its own PageHeader — in the content column. The individual pages
// keep their routes and guards; entries the member may not view are hidden
// (pages still guard authoritatively). Server component; the active entry
// follows the pathname inside SubNav.
import type { ReactNode } from 'react';
import { canViewArea, isAdminRole, type MemberAccess } from '@zendori/core';
import SubNav from '@/components/ui/SubNav';
import { href } from '@/lib/href';

export type SettingsTabKey =
  | 'organization'
  | 'phone-numbers'
  | 'ai'
  | 'tickets'
  | 'canned-responses'
  | 'integrations'
  | 'billing'
  | 'notifications';

const TABS: { key: SettingsTabKey; href: string; label: string }[] = [
  { key: 'organization', href: '/settings/organization', label: 'Organisation' },
  { key: 'phone-numbers', href: '/settings/phone-numbers', label: 'Telefonnummern' },
  { key: 'ai', href: '/settings/ai', label: 'Übergabe & Zeiten' },
  { key: 'tickets', href: '/settings/tickets', label: 'Tickets' },
  { key: 'canned-responses', href: '/settings/canned-responses', label: 'Textbausteine' },
  { key: 'integrations', href: '/settings/integrations', label: 'Integrationen' },
  { key: 'billing', href: '/settings/billing', label: 'Abrechnung' },
  // personal, not org config: every member manages their own e-mail notifications
  { key: 'notifications', href: '/settings/notifications', label: 'Benachrichtigungen' },
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
    case 'tickets':
      // numbering is org config (owner/admin write); members with the area may read it
      return isAdminRole(access.role) || canViewArea(access, 'tickets');
    case 'canned-responses':
      return canViewArea(access, 'canned');
    case 'billing':
      return canViewArea(access, 'billing');
    case 'notifications':
      return true;
  }
}

/** First tab this member may open (the /settings index redirect target). */
export function firstVisibleSettingsTab(access: MemberAccess): string | null {
  const tab = TABS.find((t) => settingsTabVisible(access, t.key));
  return tab ? tab.href : null;
}

/**
 * Wraps one page of the hub. With a single visible entry there is nothing to
 * navigate between, so the page renders without the sub-navigation.
 */
export default function SettingsFrame({
  access,
  orgId,
  children,
}: {
  access: MemberAccess;
  orgId: string;
  children: ReactNode;
}) {
  const visible = TABS.filter((t) => settingsTabVisible(access, t.key));
  if (visible.length <= 1) return <>{children}</>;
  return (
    <div className="with-subnav">
      <SubNav
        label="Einstellungen"
        items={visible.map((tab) => ({ href: href(tab.href, { org: orgId }), label: tab.label }))}
      />
      <div className="with-subnav-content">{children}</div>
    </div>
  );
}
