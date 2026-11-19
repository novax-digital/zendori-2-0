// Loading placeholders (docs/design-redesign.md §4): grey bars in the shape of
// the page that is on its way. They are built from the SAME layout classes as
// the real pages (.page-head, table rows, .inbox-layout …), so the frame does
// not jump when the content arrives. No hooks — usable in server and client
// components; which skeleton a route gets is decided in RouteSkeleton.
import type { ReactNode } from 'react';

type Width = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
type Shape = 'text' | 'icon' | 'button' | 'field' | 'bubble';

/**
 * One placeholder. `text` is a bar that sits on the text line of the element
 * around it (h1, p, td …) and so inherits that element's line height.
 */
export function Skeleton({ width = 'md', shape = 'text' }: { width?: Width; shape?: Shape }) {
  return <span className={`skeleton skeleton--${shape} skeleton--${width}`} aria-hidden="true" />;
}

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

/** Bars of varying length read as text; a fixed rhythm keeps server and client output equal. */
const LINE_WIDTHS: Width[] = ['lg', 'md', 'xl', 'md', 'lg', 'sm'];
const lineWidth = (index: number): Width => LINE_WIDTHS[index % LINE_WIDTHS.length] ?? 'md';

/** Wrapper of every page skeleton: announces "loading" once, hides the bars from assistive tech. */
function SkeletonFrame({
  className,
  label = 'Seite wird geladen',
  children,
}: {
  className: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className={`${className} skeleton-page`} role="status" aria-label={label}>
      {children}
    </div>
  );
}

function HeadSkeleton({ crumbs = false, action = true }: { crumbs?: boolean; action?: boolean }) {
  return (
    <div className="page-head">
      <div className="page-head-main">
        {crumbs ? (
          <div className="page-head-crumbs">
            <Skeleton width="xs" />
            <Skeleton width="sm" />
          </div>
        ) : null}
        <div className="page-head-title">
          <h1>
            <Skeleton width="md" />
          </h1>
        </div>
        <p>
          <Skeleton width="xl" />
        </p>
      </div>
      {action ? (
        <div className="page-head-actions">
          <Skeleton shape="button" />
        </div>
      ) : null}
    </div>
  );
}

function SectionsSkeleton() {
  return (
    <div className="skeleton-form">
      {range(2).map((section) => (
        <div key={section} className="section">
          <div className="section-head">
            <div className="section-head-text">
              <h2>
                <Skeleton width="md" />
              </h2>
            </div>
          </div>
          <div className="skeleton-lines skeleton-lines--fields">
            {range(section === 0 ? 3 : 2).map((field) => (
              <div key={field} className="skeleton-lines">
                <Skeleton width="xs" />
                <Skeleton shape="field" width="full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Page type B: head with one action, a table of rows. */
export function ListSkeleton() {
  return (
    <SkeletonFrame className="page">
      <HeadSkeleton />
      <div className="page-body">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  <Skeleton width="xs" />
                </th>
                <th>
                  <Skeleton width="xs" />
                </th>
                <th>
                  <Skeleton width="xs" />
                </th>
              </tr>
            </thead>
            <tbody>
              {range(6).map((row) => (
                <tr key={row}>
                  <td>
                    <div className="cell-main">
                      <Skeleton shape="icon" />
                      <div className="grow skeleton-lines">
                        <Skeleton width={lineWidth(row)} />
                        <Skeleton width="sm" />
                      </div>
                    </div>
                  </td>
                  <td>
                    <Skeleton width="sm" />
                  </td>
                  <td>
                    <Skeleton width="sm" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </SkeletonFrame>
  );
}

/** Page type C: head (with breadcrumb for pages below a list), sections of fields. */
export function DetailSkeleton({ crumbs = true }: { crumbs?: boolean }) {
  return (
    <SkeletonFrame className="page">
      <HeadSkeleton crumbs={crumbs} action={false} />
      <div className="page-body">
        <SectionsSkeleton />
      </div>
    </SkeletonFrame>
  );
}

/** Page type D: the sub-navigation column next to a page of sections (Einstellungen). */
export function SettingsSkeleton() {
  return (
    <div className="with-subnav">
      <div className="subnav skeleton-page" aria-hidden="true">
        <div className="subnav-title">
          <Skeleton width="sm" />
        </div>
        {range(7).map((item) => (
          <div key={item} className="skeleton-subnav-item">
            <Skeleton width={item % 2 === 0 ? 'md' : 'sm'} />
          </div>
        ))}
      </div>
      <div className="with-subnav-content">
        <DetailSkeleton crumbs={false} />
      </div>
    </div>
  );
}

/**
 * Page type A: the three inbox columns. `thread` draws message bubbles and
 * detail rows — only when the URL already names a conversation; otherwise the
 * middle and right column stay empty, as on the real page.
 */
export function InboxSkeleton({ thread = false }: { thread?: boolean }) {
  return (
    <SkeletonFrame className="inbox-shell" label="Inbox wird geladen">
      <div className="inbox-layout">
        <div className="inbox-col inbox-col--list">
          <div className="inbox-head inbox-head--plain">
            <h1>
              <Skeleton width="sm" />
            </h1>
          </div>
          <div className="skeleton-tabs">
            <Skeleton width="xs" />
            <Skeleton width="xs" />
            <Skeleton width="xs" />
          </div>
          <div className="inbox-list">
            {range(7).map((row) => (
              <div key={row} className="inbox-row">
                <Skeleton shape="icon" width="xs" />
                <div className="inbox-row-body skeleton-lines">
                  <Skeleton width={row % 2 === 0 ? 'md' : 'sm'} />
                  <Skeleton width={lineWidth(row)} />
                  <Skeleton width="sm" />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="inbox-col inbox-col--thread">
          <div className="inbox-head inbox-head--thread">
            <h2>{thread ? <Skeleton width="lg" /> : null}</h2>
          </div>
          {thread ? (
            <div className="skeleton-thread">
              <Skeleton shape="bubble" width="lg" />
              <span className="skeleton-thread-out">
                <Skeleton shape="bubble" width="xl" />
              </span>
              <Skeleton shape="bubble" width="xl" />
              <span className="skeleton-thread-out">
                <Skeleton shape="bubble" width="lg" />
              </span>
            </div>
          ) : null}
        </div>

        <div className="inbox-col inbox-col--context">
          <div className="inbox-head">
            <h2>
              <Skeleton width="sm" />
            </h2>
          </div>
          {thread
            ? range(3).map((block) => (
                <div key={block} className="rail-section skeleton-lines">
                  <Skeleton width="sm" />
                  <Skeleton width="lg" />
                  <Skeleton width="md" />
                </div>
              ))
            : null}
        </div>
      </div>
    </SkeletonFrame>
  );
}
