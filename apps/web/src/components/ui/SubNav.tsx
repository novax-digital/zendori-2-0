'use client';

// Vertical sub-navigation (redesign, docs/design-redesign.md §4): the second
// navigation level of an area with several sibling pages — the Plattform
// (admin) area now, Einstellungen from stage 6. The active item follows the
// pathname, so the surrounding layout can stay a server component.
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface SubNavItem {
  /** May carry a query string (e.g. ?org=…); only the path decides "active". */
  href: string;
  label: string;
}

export default function SubNav({ label, items }: { label: string; items: SubNavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="subnav" aria-label={label}>
      <div className="subnav-title">{label}</div>
      {items.map((item) => {
        const path = item.href.split('?')[0] ?? item.href;
        const active = pathname === path || pathname.startsWith(`${path}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`subnav-item${active ? ' subnav-item--active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
