'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { signOut } from '@/app/actions';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import ThemeToggle from './ThemeToggle';
import Icon, { type IconName } from './ui/Icon';
import { useDismiss } from './ui/useDismiss';
// Client-safe subpath: the @zendori/core barrel pulls node:crypto (webhooks)
// and cannot be bundled for the browser.
import {
  EMPTY_PERMISSIONS,
  LEGACY_AGENT_PERMISSIONS,
  ORG_ROLE_LABELS,
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

type NavItem = { href: string; label: string; icon: IconName };
type NavSection = { title?: string; items: NavItem[] };

// Redesign stage 2 (docs/design-redesign.md §6): three groups, routes
// unchanged. The former "Werkzeuge" group is gone — MD-Generator lives in the
// Wissensdatenbank page head, Test-Channel in the Kanäle page head, Widget-Demo
// on the chat channel page. ONE "Einstellungen" entry leads to the tabbed hub
// (SettingsTabs), ONE "Plattform" entry to the admin area (its own sub-nav).
const NAV: NavSection[] = [
  {
    items: [
      { href: '/inbox', label: 'Inbox', icon: 'inbox' },
      { href: '/tickets', label: 'Tickets', icon: 'ticket' },
    ],
  },
  {
    title: 'Einrichten',
    items: [
      { href: '/settings/agents', label: 'Agenten', icon: 'ai' },
      { href: '/settings/knowledge', label: 'Wissen', icon: 'book' },
      { href: '/settings/channels', label: 'Kanäle', icon: 'channels' },
      { href: '/settings/forms', label: 'Formulare', icon: 'form' },
    ],
  },
  {
    title: 'Organisation',
    items: [
      { href: '/settings/members', label: 'Team', icon: 'team' },
      { href: '/settings', label: 'Einstellungen', icon: 'settings' },
    ],
  },
];

/**
 * 0024 nav gating: which permission each nav item needs. 'admin' = owner/admin
 * only; undefined = always visible. Pages enforce authoritatively — this only
 * hides what the member cannot use anyway.
 */
const NAV_ACCESS: Record<string, { area: AreaKey; level: 'view' | 'edit' } | 'admin' | 'settings-hub'> = {
  '/inbox': { area: 'inbox', level: 'view' },
  '/tickets': { area: 'tickets', level: 'view' },
  '/settings/agents': { area: 'agents', level: 'view' },
  '/settings/knowledge': { area: 'knowledge', level: 'view' },
  '/settings/channels': { area: 'channels', level: 'view' },
  '/settings/forms': { area: 'channels', level: 'view' },
  '/settings/members': 'admin',
  '/settings': 'settings-hub',
};

/** Pages without a sidebar entry of their own highlight the entry they are reached from. */
const NAV_ALSO_ACTIVE: Record<string, string[]> = {
  '/settings/knowledge': ['/tools/md-generator'],
  '/settings/channels': ['/test-channel'],
};

/** Tab routes of the Einstellungen hub — drive the hub's active state + visibility. */
const SETTINGS_TAB_ROUTES = [
  '/settings/organization',
  '/settings/phone-numbers',
  '/settings/ai',
  '/settings/tickets',
  '/settings/canned-responses',
  '/settings/integrations',
  '/settings/billing',
];

function navItemVisible(access: MemberAccess | null, href: string): boolean {
  if (!access) return true; // loading / pre-0024: show everything (pages guard)
  const need = NAV_ACCESS[href];
  if (!need) return true;
  if (need === 'admin') return access.role === 'owner' || access.role === 'admin';
  if (need === 'settings-hub') {
    if (access.role === 'owner' || access.role === 'admin') return true;
    return (['channels', 'handoff', 'tickets', 'canned', 'billing'] as AreaKey[]).some((area) =>
      canViewArea(access, area)
    );
  }
  return need.level === 'edit' ? canEditArea(access, need.area) : canViewArea(access, need.area);
}

type OrgOption = { id: string; name: string };

/**
 * Sidebar head: logo mark + name of the active organisation. With several
 * memberships it is a button that opens the organisation list; with one it is
 * a plain link to the inbox.
 */
function OrgSwitcher({
  orgs,
  activeOrgId,
  activeName,
  pathname,
  homeHref,
}: {
  orgs: OrgOption[];
  activeOrgId: string;
  activeName: string;
  pathname: string;
  homeHref: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, setOpen);

  const brand = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="app-org-logo" src="/brand/icon.svg" alt="" />
      <span className="app-org-name">{activeName}</span>
    </>
  );

  if (orgs.length <= 1) {
    return (
      <Link href={homeHref} className="app-org" aria-label={`${activeName} — zur Inbox`}>
        {brand}
      </Link>
    );
  }

  return (
    <div className="app-org-wrap" ref={ref}>
      <button
        type="button"
        className="app-org"
        aria-expanded={open}
        aria-controls="app-org-list"
        aria-label={`Organisation wechseln, aktiv: ${activeName}`}
        title="Organisation wechseln"
        onClick={() => setOpen((value) => !value)}
      >
        {brand}
        <span className="app-org-chevron">
          <Icon name="chevronDown" />
        </span>
      </button>
      <div id="app-org-list" className="menu-pop app-pop app-pop--org" hidden={!open}>
        {orgs.map((option) => (
          <Link
            key={option.id}
            href={`${pathname}?org=${option.id}`}
            className="menu-item"
            aria-current={option.id === activeOrgId ? 'true' : undefined}
            onClick={() => setOpen(false)}
          >
            <span className="menu-label">{option.name}</span>
            {option.id === activeOrgId ? <Icon name="check" /> : null}
          </Link>
        ))}
      </div>
    </div>
  );
}

/**
 * Sidebar foot: one row (avatar, e-mail, role). It opens the account menu with
 * the colour scheme, the collapse toggle and sign-out. The menu stays mounted
 * while closed so ThemeToggle keeps following the OS scheme in 'auto'.
 */
function AccountMenu({
  email,
  roleLabel,
  collapsed,
  onToggleCollapse,
}: {
  email: string;
  roleLabel: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, setOpen);
  const initial = (email.trim()[0] ?? 'Z').toUpperCase();

  return (
    <div className="app-account-wrap" ref={ref}>
      <div id="app-account-menu" className="menu-pop app-pop app-pop--account" hidden={!open}>
        <div className="app-pop-head">{email || '—'}</div>
        <div className="app-pop-row">
          <span>Design</span>
          <ThemeToggle />
        </div>
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            onToggleCollapse();
            setOpen(false);
          }}
        >
          <Icon name="collapse" />
          <span className="menu-label">
            {collapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'}
          </span>
        </button>
        <form action={signOut}>
          <button type="submit" className="menu-item">
            <Icon name="signout" />
            <span className="menu-label">Abmelden</span>
          </button>
        </form>
      </div>
      <button
        type="button"
        className="app-account"
        aria-expanded={open}
        aria-controls="app-account-menu"
        aria-label={`Konto-Menü: ${email}`}
        title={email}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="app-account-avatar">{initial}</span>
        <span className="app-account-meta">
          <span className="app-account-email">{email || '—'}</span>
          <span className="app-account-role">{roleLabel}</span>
        </span>
        <span className="app-account-more">
          <Icon name="more" />
        </span>
      </button>
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
  const [email, setEmail] = useState<string>('');
  const [orgs, setOrgs] = useState<OrgOption[]>([]);

  useEffect(() => {
    const stored = localStorage.getItem('zendori-nav-collapsed');
    if (stored !== null) setCollapsed(stored === '1');
  }, []);

  // Account e-mail + the organisations this user belongs to (org switcher).
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
  const isActive = (href: string) => {
    if (href === '/inbox') return pathname === '/inbox';
    if (href === '/settings') {
      return pathname === '/settings' || SETTINGS_TAB_ROUTES.some((r) => pathname.startsWith(r));
    }
    return (
      pathname.startsWith(href) ||
      (NAV_ALSO_ACTIVE[href] ?? []).some((other) => pathname.startsWith(other))
    );
  };

  const activeOrgId = (org && orgs.some((o) => o.id === org) ? org : orgs[0]?.id) ?? '';
  const activeOrgName = orgs.find((o) => o.id === activeOrgId)?.name ?? 'Zendori';
  const adminActive = pathname.startsWith('/admin');

  return (
    <aside className={`app-sidebar${collapsed ? ' app-sidebar--collapsed' : ''}`}>
      <OrgSwitcher
        orgs={orgs}
        activeOrgId={activeOrgId}
        activeName={activeOrgName}
        pathname={pathname}
        homeHref={withOrg('/inbox')}
      />

      <nav className="app-nav" aria-label="Hauptnavigation">
        {NAV.map((section, i) => {
          const items = section.items.filter((item) => navItemVisible(memberAccess, item.href));
          if (items.length === 0) return null;
          return (
            <div className="app-nav-group" key={section.title ?? `sec-${i}`}>
              {section.title ? <div className="app-nav-section">{section.title}</div> : null}
              {items.map((item) => (
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
          );
        })}
        {isAdmin ? (
          <div className="app-nav-group">
            <div className="app-nav-section">Zendori</div>
            <Link
              href="/admin"
              className={`app-nav-item${adminActive ? ' app-nav-item--active' : ''}`}
              title="Plattform"
              aria-current={adminActive ? 'page' : undefined}
            >
              <span className="app-nav-icon">
                <Icon name="shield" />
              </span>
              <span className="app-nav-label">Plattform</span>
            </Link>
          </div>
        ) : null}
      </nav>

      <AccountMenu
        email={email}
        roleLabel={memberAccess ? ORG_ROLE_LABELS[memberAccess.role] : ''}
        collapsed={collapsed}
        onToggleCollapse={toggle}
      />
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
