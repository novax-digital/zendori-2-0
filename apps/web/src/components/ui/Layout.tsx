// Content building blocks (redesign stage 3). Server components.
// Page skeletons that use them: docs/design-redesign.md §5.
import type { ReactNode } from 'react';
import Link from 'next/link';

/**
 * A titled block of content. Sections are separated by space and their
 * heading — NO border, NO background (this replaces .panel).
 *   <Section title="Geschäftszeiten" help="Außerhalb dieser Zeiten …">…</Section>
 */
export function Section({
  title,
  help,
  actions,
  children,
}: {
  title: ReactNode;
  /** One sentence below the title. */
  help?: ReactNode;
  /** Small actions on the right of the title (links, sm buttons). */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <div className="section-head-text">
          <h2>{title}</h2>
          {help ? <p className="field-help">{help}</p> : null}
        </div>
        {actions ? <div className="section-head-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Label/value rows for side rails (ticket, conversation, contact).
 *   <PropertyList>
 *     <Property label="Kanal">E-Mail Support</Property>
 *     <Property label="Status"><select …/></Property>
 *   </PropertyList>
 */
export function PropertyList({ children }: { children: ReactNode }) {
  return <dl className="props">{children}</dl>;
}

export function Property({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="prop">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * What a list or section shows when it has nothing: one title, one sentence,
 * at most one action. Replaces the loose grey paragraphs.
 *   <EmptyState title="Noch keine Kanäle" text="Lege den ersten Kanal an."
 *     action={<Button href="?panel=new" variant="primary">Neuer Kanal</Button>} />
 */
export function EmptyState({
  title,
  text,
  action,
}: {
  title: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {text ? <p className="empty-text">{text}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export interface TabItem {
  label: ReactNode;
  href: string;
  /** Shown muted behind the label. */
  count?: number;
  active?: boolean;
}

/**
 * Page tabs: the one allowed second navigation level (next to SubNav).
 * URL-driven — every tab is a link; pass them to <PageHeader tabs={…}>.
 *   <Tabs label="Status" items={[{ label: 'Offen', href: '…', count: 4, active: true }, …]} />
 * In-form tabs that must keep all fields mounted (agent editor) use the same
 * look via EditTabs.
 */
export function Tabs({ label, items }: { label: string; items: TabItem[] }) {
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          scroll={false}
          aria-current={item.active ? 'page' : undefined}
        >
          {item.label}
          {item.count !== undefined ? <span className="tabs-count">{item.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/** Initials on a neutral disc. `name` may be a full name or an e-mail address. */
export function Avatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' }) {
  const words = name.trim().split(/[\s._@-]+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? '') + (words.length > 1 ? (words[1]?.[0] ?? '') : ''))
    .toUpperCase();
  return (
    <span className={`avatar${size === 'md' ? ' avatar--md' : ''}`} aria-hidden="true">
      {initials || '?'}
    </span>
  );
}

/**
 * A row of key figures (billing, platform overviews).
 *   <Stats><Stat label="Konversationen" value="1.204" note="diesen Monat" /></Stats>
 */
export function Stats({ children }: { children: ReactNode }) {
  return <div className="stats">{children}</div>;
}

export function Stat({
  label,
  value,
  note,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

/** Addresses, embed codes, webhook URLs — anything the user copies verbatim. */
export function CodeBlock({ children }: { children: ReactNode }) {
  return <code className="code-block">{children}</code>;
}
