// Plattform (operator) area: the sidebar has ONE "Plattform" entry; the five
// admin pages are reached through this sub-navigation (redesign stage 2).
// The guard runs here too, so the navigation never renders for non-admins —
// every page still guards authoritatively.
import type { ReactNode } from 'react';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import SubNav, { type SubNavItem } from '@/components/ui/SubNav';

const ITEMS: SubNavItem[] = [
  { href: '/admin/users', label: 'Nutzer' },
  { href: '/admin/phone-numbers', label: 'Telefonnummern' },
  { href: '/admin/demo', label: 'Demo-Anrufe' },
  { href: '/admin/billing', label: 'Abrechnung' },
  { href: '/admin/pricing', label: 'Preise & Pakete' },
  // living reference of the redesign's building blocks (docs/design-redesign.md §4)
  { href: '/admin/ui', label: 'UI-Bausteine' },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requirePlatformAdmin();
  return (
    <div className="with-subnav">
      <SubNav label="Plattform" items={ITEMS} />
      <div className="with-subnav-content">{children}</div>
    </div>
  );
}
