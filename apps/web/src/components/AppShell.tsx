'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { signOut } from '@/app/actions';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import ThemeToggle from './ThemeToggle';
// Client-safe subpath: the @zendori/core barrel pulls node:crypto (webhooks)
// and cannot be bundled for the browser.
import {
  EMPTY_PERMISSIONS,
  LEGACY_AGENT_PERMISSIONS,
  canEditArea,
  canViewArea,
  parseMemberPermissions,
  type AreaKey,
  type MemberAccess,
  type OrgRole,
} from '@zendori/core/permissions';

// Routes that render without the app chrome (auth + embeddable/demo surfaces).
const BARE_PREFIXES = [
  '/login',
  '/register',
  '/onboarding',
  '/invite',
  '/widget-demo',
  '/widget-host',
  // hosted public form page — trailing slash on purpose: startsWith('/f')
  // would swallow every future /f* route
  '/f/',
];

type IconName =
  | 'inbox'
  | 'book'
  | 'form'
  | 'channels'
  | 'ai'
  | 'canned'
  | 'team'
  | 'integrations'
  | 'test'
  | 'widget'
  | 'shield'
  | 'clock'
  | 'phone'
  | 'billing'
  | 'package'
  | 'chevron'
  | 'signout';

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 24,
    height: 24,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'inbox':
      return (
        <svg {...common}>
          <path d="M4 13h4l1.5 3h5L16 13h4" />
          <path d="M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7l-1.5 5a2 2 0 0 1-2 1.5H7.5a2 2 0 0 1-2-1.5L4 13Z" />
        </svg>
      );
    case 'book':
      return (
        <svg {...common}>
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" />
          <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20" />
        </svg>
      );
    case 'form':
      return (
        <svg {...common}>
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <path d="M9 8h6M9 12h6M9 16h3" />
        </svg>
      );
    case 'channels':
      return (
        <svg {...common}>
          <path d="M10 3 8 21M16 3l-2 18M4 8h17M3 16h17" />
        </svg>
      );
    case 'ai':
      return (
        <svg {...common}>
          <path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4L12 3Z" />
          <path d="M18 15l.9 2.3L21 18l-2.1.7L18 21l-.9-2.3L15 18l2.1-.7L18 15Z" />
        </svg>
      );
    case 'canned':
      return (
        <svg {...common}>
          <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 4v-4H6a2 2 0 0 1-2-2V6Z" />
          <path d="M8 9h8M8 12h5" />
        </svg>
      );
    case 'team':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 20a6 6 0 0 1 12 0" />
          <path d="M16 6a3 3 0 0 1 0 6M17 20a6 6 0 0 0-2-4.7" />
        </svg>
      );
    case 'integrations':
      return (
        <svg {...common}>
          <path d="M9 3v4M15 3v4M8 7h8v3a4 4 0 0 1-4 4 4 4 0 0 1-4-4V7Z" />
          <path d="M12 14v7" />
        </svg>
      );
    case 'test':
      return (
        <svg {...common}>
          <path d="M9 3h6M10 3v6l-4.5 8A2 2 0 0 0 7.3 20h9.4a2 2 0 0 0 1.8-3L14 9V3" />
          <path d="M8 15h8" />
        </svg>
      );
    case 'widget':
      return (
        <svg {...common}>
          <path d="m8 9-3 3 3 3M16 9l3 3-3 3M13 7l-2 10" />
        </svg>
      );
    case 'shield':
      return (
        <svg {...common}>
          <path d="M12 3l7 3v5c0 4.4-2.9 7.9-7 9-4.1-1.1-7-4.6-7-9V6l7-3Z" />
          <path d="m9.5 12 1.8 1.8L15 10" />
        </svg>
      );
    case 'clock':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
    case 'phone':
      return (
        <svg {...common}>
          <path d="M5 4h4l1.5 4.5-2.2 1.6a12.5 12.5 0 0 0 5.6 5.6l1.6-2.2L20 15v4a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2Z" />
        </svg>
      );
    case 'billing':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M15 9.5a4 4 0 0 0-3-1.5c-2 0-3.5 1.8-3.5 4s1.5 4 3.5 4a4 4 0 0 0 3-1.5M7.5 11.5h5M7.5 13.5h4" />
        </svg>
      );
    case 'package':
      return (
        <svg {...common}>
          <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
          <path d="m3 8 9 5 9-5M12 13v8" />
        </svg>
      );
    case 'chevron':
      return (
        <svg {...common}>
          <path d="m15 6-6 6 6 6" />
        </svg>
      );
    case 'signout':
      return (
        <svg {...common}>
          <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 12H4M8 8l-4 4 4 4" />
        </svg>
      );
  }
}

type NavItem = { href: string; label: string; icon: IconName };
type NavSection = { title?: string; items: NavItem[] };

const NAV: NavSection[] = [
  { items: [{ href: '/inbox', label: 'Inbox', icon: 'inbox' }] },
  {
    title: 'Einstellungen',
    items: [
      { href: '/settings/agents', label: 'Agenten', icon: 'ai' },
      { href: '/settings/knowledge', label: 'Wissensdatenbank', icon: 'book' },
      { href: '/settings/channels', label: 'Kanäle', icon: 'channels' },
      { href: '/settings/forms', label: 'Formulare', icon: 'form' },
      { href: '/settings/phone-numbers', label: 'Telefonnummern', icon: 'phone' },
      { href: '/settings/ai', label: 'Übergabe & Zeiten', icon: 'clock' },
      { href: '/settings/canned-responses', label: 'Textbausteine', icon: 'canned' },
      { href: '/settings/members', label: 'Team', icon: 'team' },
      { href: '/settings/integrations', label: 'Integrationen', icon: 'integrations' },
      { href: '/settings/billing', label: 'Abrechnung', icon: 'billing' },
    ],
  },
  {
    title: 'Werkzeuge',
    items: [
      { href: '/test-channel', label: 'Test-Channel', icon: 'test' },
      { href: '/widget-demo', label: 'Widget-Demo', icon: 'widget' },
    ],
  },
];

/**
 * 0024 nav gating: which permission each nav item needs. 'admin' = owner/admin
 * only; undefined = always visible. Pages enforce authoritatively — this only
 * hides what the member cannot use anyway.
 */
const NAV_ACCESS: Record<string, { area: AreaKey; level: 'view' | 'edit' } | 'admin'> = {
  '/inbox': { area: 'inbox', level: 'view' },
  '/settings/agents': { area: 'agents', level: 'view' },
  '/settings/knowledge': { area: 'knowledge', level: 'view' },
  '/settings/channels': { area: 'channels', level: 'view' },
  '/settings/forms': { area: 'channels', level: 'view' },
  '/settings/phone-numbers': { area: 'channels', level: 'view' },
  '/settings/ai': { area: 'handoff', level: 'view' },
  '/settings/canned-responses': { area: 'canned', level: 'view' },
  '/settings/members': 'admin',
  '/settings/integrations': 'admin',
  '/settings/billing': { area: 'billing', level: 'view' },
  '/test-channel': { area: 'inbox', level: 'edit' },
  '/widget-demo': { area: 'inbox', level: 'view' },
};

function navItemVisible(access: MemberAccess | null, href: string): boolean {
  if (!access) return true; // loading / pre-0024: show everything (pages guard)
  const need = NAV_ACCESS[href];
  if (!need) return true;
  if (need === 'admin') return access.role === 'owner' || access.role === 'admin';
  return need.level === 'edit' ? canEditArea(access, need.area) : canViewArea(access, need.area);
}

type OrgOption = { id: string; name: string };

function SidebarAccount({ collapsed, org }: { collapsed: boolean; org: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [email, setEmail] = useState<string>('');
  const [orgs, setOrgs] = useState<OrgOption[]>([]);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let active = true;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!active || !user) return;
      setEmail(user.email ?? '');
      const { data } = await supabase
        .from('org_members')
        .select('org_id, organizations(name)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: true });
      const rows = (data ?? []) as unknown as {
        org_id: string;
        organizations: { name: string } | null;
      }[];
      if (active) {
        setOrgs(rows.map((r) => ({ id: r.org_id, name: r.organizations?.name ?? 'Organisation' })));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const activeOrgId = (org && orgs.some((o) => o.id === org) ? org : orgs[0]?.id) ?? '';
  const activeOrg = orgs.find((o) => o.id === activeOrgId);
  const initial = (email.trim()[0] ?? 'Z').toUpperCase();

  return (
    <div className="app-sidebar-footer">
      {orgs.length > 1 && !collapsed ? (
        <select
          className="app-orgswitch"
          aria-label="Organisation wechseln"
          value={activeOrgId}
          onChange={(e) => router.push(`${pathname}?org=${e.target.value}`)}
        >
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      ) : null}
      <div className="app-account" title={email}>
        <span className="app-account-avatar">{initial}</span>
        <span className="app-account-meta">
          <span className="app-account-email">{email || '—'}</span>
          <span className="app-account-org">{activeOrg?.name ?? 'Zendori'}</span>
        </span>
      </div>
      <div className="app-footer-actions">
        <form action={signOut} style={{ flex: 1, display: 'flex' }}>
          <button className="app-signout" type="submit" title="Abmelden">
            <Icon name="signout" />
            <span className="app-signout-label">Abmelden</span>
          </button>
        </form>
      </div>
    </div>
  );
}

function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const org = searchParams.get('org');
  const [collapsed, setCollapsed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [memberAccess, setMemberAccess] = useState<MemberAccess | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem('zendori-nav-collapsed');
    if (stored !== null) setCollapsed(stored === '1');
  }, []);

  // Platform-admin check: the self-select RLS policy returns the user's own row
  // only for admins. Before the migration the table is absent → error → stays false.
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let active = true;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!active || !user) return;
      const { data } = await supabase
        .from('platform_admins')
        .select('user_id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (active && data) setIsAdmin(true);
      // 0024: own membership (role + permissions) for nav gating. permissions
      // is post-migration — fall back to role-only on 42703.
      const activeOrg = org;
      // eslint-disable-next-line prefer-const -- memberRows IS reassigned in the fallback
      let { data: memberRows, error: memberErr } = await supabase
        .from('org_members')
        .select('org_id, role, permissions')
        .eq('user_id', user.id)
        .order('created_at', { ascending: true });
      if (memberErr && (memberErr as { code?: string }).code === '42703') {
        const retry = await supabase
          .from('org_members')
          .select('org_id, role')
          .eq('user_id', user.id)
          .order('created_at', { ascending: true });
        memberRows = retry.data as unknown as typeof memberRows;
      }
      if (active && memberRows && memberRows.length > 0) {
        const rows = memberRows as { org_id: string; role: OrgRole; permissions?: unknown }[];
        const row = rows.find((r) => r.org_id === activeOrg) ?? rows[0];
        if (row) {
          setMemberAccess({
            role: row.role,
            // Pre-0024 skew: agents keep legacy full access instead of lockout.
            permissions:
              row.permissions === undefined
                ? row.role === 'agent'
                  ? LEGACY_AGENT_PERMISSIONS
                  : EMPTY_PERMISSIONS
                : parseMemberPermissions(row.permissions),
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [org]);

  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem('zendori-nav-collapsed', next ? '1' : '0');
      return next;
    });

  const withOrg = (href: string) => (org ? `${href}?org=${org}` : href);
  const isActive = (href: string) =>
    href === '/inbox' ? pathname === '/inbox' : pathname.startsWith(href);

  return (
    <aside className={`app-sidebar${collapsed ? ' app-sidebar--collapsed' : ''}`}>
      <Link href={withOrg('/inbox')} className="app-brand" aria-label="Zendori — zur Inbox">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="app-brand-wordmark app-brand-wordmark--onlight"
          src="/brand/logo-onlight.svg"
          alt="Zendori"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="app-brand-wordmark app-brand-wordmark--ondark"
          src="/brand/logo-ondark.svg"
          alt="Zendori"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="app-brand-icon" src="/brand/icon.svg" alt="Zendori" />
      </Link>

      <nav className="app-nav" aria-label="Hauptnavigation">
        {NAV.map((section, i) => (
          <div key={section.title ?? `sec-${i}`}>
            {section.title ? <div className="app-nav-section">{section.title}</div> : null}
            {section.items.filter((item) => navItemVisible(memberAccess, item.href)).map((item) => (
              <Link
                key={item.href}
                href={withOrg(item.href)}
                className={`app-nav-item${isActive(item.href) ? ' app-nav-item--active' : ''}`}
                title={item.label}
                aria-current={isActive(item.href) ? 'page' : undefined}
              >
                <span className="app-nav-icon">
                  <Icon name={item.icon} />
                </span>
                <span className="app-nav-label">{item.label}</span>
              </Link>
            ))}
          </div>
        ))}
        {isAdmin ? (
          <div>
            <div className="app-nav-section">Zendori</div>
            <Link
              href="/admin/users"
              className={`app-nav-item${pathname.startsWith('/admin/users') || pathname === '/admin' ? ' app-nav-item--active' : ''}`}
              title="Admin"
              aria-current={pathname.startsWith('/admin/users') ? 'page' : undefined}
            >
              <span className="app-nav-icon">
                <Icon name="shield" />
              </span>
              <span className="app-nav-label">Admin</span>
            </Link>
            <Link
              href="/admin/phone-numbers"
              className={`app-nav-item${pathname.startsWith('/admin/phone-numbers') ? ' app-nav-item--active' : ''}`}
              title="Nummern"
              aria-current={pathname.startsWith('/admin/phone-numbers') ? 'page' : undefined}
            >
              <span className="app-nav-icon">
                <Icon name="phone" />
              </span>
              <span className="app-nav-label">Nummern</span>
            </Link>
            <Link
              href="/admin/billing"
              className={`app-nav-item${pathname.startsWith('/admin/billing') ? ' app-nav-item--active' : ''}`}
              title="Abrechnung"
              aria-current={pathname.startsWith('/admin/billing') ? 'page' : undefined}
            >
              <span className="app-nav-icon">
                <Icon name="billing" />
              </span>
              <span className="app-nav-label">Abrechnung</span>
            </Link>
            <Link
              href="/admin/pricing"
              className={`app-nav-item${pathname.startsWith('/admin/pricing') ? ' app-nav-item--active' : ''}`}
              title="Preise & Pakete"
              aria-current={pathname.startsWith('/admin/pricing') ? 'page' : undefined}
            >
              <span className="app-nav-icon">
                <Icon name="package" />
              </span>
              <span className="app-nav-label">Preise & Pakete</span>
            </Link>
          </div>
        ) : null}
      </nav>

      <SidebarAccount collapsed={collapsed} org={org} />
      <div style={{ padding: '0 0.6rem 0.7rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <ThemeToggle />
        <button
          className="app-collapse-btn"
          type="button"
          onClick={toggle}
          style={{ width: '100%' }}
          aria-label={collapsed ? 'Navigation ausklappen' : 'Navigation einklappen'}
          title={collapsed ? 'Ausklappen' : 'Einklappen'}
        >
          <Icon name="chevron" />
          <span className="app-signout-label">Einklappen</span>
        </button>
      </div>
    </aside>
  );
}

/**
 * App chrome: a collapsible left sidebar + main content area. Auth/embeddable
 * routes render bare (no chrome). Rendered once in the root layout.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const bare = pathname === '/' || BARE_PREFIXES.some((p) => pathname.startsWith(p));

  if (bare) return <>{children}</>;

  return (
    <div className="app-shell">
      <Suspense fallback={<aside className="app-sidebar" />}>
        <Sidebar />
      </Suspense>
      <main className="app-main">{children}</main>
    </div>
  );
}
