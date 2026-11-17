// Page head of every app page (redesign stage 2, docs/design-redesign.md §5):
// optional breadcrumb, title with status badges, a one-sentence subtitle,
// actions on the right (the primary button last) and optional page tabs on
// the bottom line. Server component — no state.
import { Fragment, type ReactNode } from 'react';
import Link from 'next/link';

export interface Crumb {
  label: string;
  /** Omit on the last crumb (the current page). */
  href?: string;
}

export default function PageHeader({
  title,
  subtitle,
  breadcrumb,
  badges,
  actions,
  tabs,
}: {
  title: ReactNode;
  /** One sentence. Explanations belong to the fields, not above the page. */
  subtitle?: ReactNode;
  breadcrumb?: Crumb[];
  /** Status badges shown next to the title. */
  badges?: ReactNode;
  /** Buttons/links on the right. At most one primary button, placed last. */
  actions?: ReactNode;
  /** Page tabs (the one allowed second navigation level). */
  tabs?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-head-main">
        {breadcrumb && breadcrumb.length > 0 ? (
          <nav className="page-head-crumbs" aria-label="Pfad">
            {breadcrumb.map((crumb, index) => (
              <Fragment key={`${crumb.label}-${index}`}>
                {index > 0 ? <span aria-hidden="true">/</span> : null}
                {crumb.href ? (
                  <Link href={crumb.href}>{crumb.label}</Link>
                ) : (
                  <span aria-current={index === breadcrumb.length - 1 ? 'page' : undefined}>
                    {crumb.label}
                  </span>
                )}
              </Fragment>
            ))}
          </nav>
        ) : null}
        <div className="page-head-title">
          <h1>{title}</h1>
          {badges}
        </div>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-head-actions">{actions}</div> : null}
      {tabs ? <div className="page-head-tabs">{tabs}</div> : null}
    </div>
  );
}
