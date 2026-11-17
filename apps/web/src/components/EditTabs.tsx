'use client';

// In-form page tabs (agent editor): sections stay MOUNTED and are only hidden,
// so all form fields keep submitting with the surrounding <form> (the
// FormBuilder always-mounted-hidden pattern). Buttons are type="button" so
// switching tabs never submits.
//
// Redesign stage 5: it renders the two page parts that belong together — the
// tab bar directly under the page head (.page-tabs, taking over the head's
// line) and the page body with the panels:
//   <PageHeader … />
//   <form …>
//     <EditTabs label="Bereiche des Agenten" before={banners} sections={…} />
//     <div className="save-bar">…</div>
//   </form>
import { useState, type ReactNode } from 'react';
import Icon from './ui/Icon';

export interface EditTabSection {
  key: string;
  label: string;
  /** Shown muted behind the label (e.g. assigned channels). */
  count?: number;
  /** Optional warning marker shown on the tab (e.g. missing knowledge base). */
  warn?: boolean;
  /** Accessible text of the warning marker. */
  warnLabel?: string;
  content: ReactNode;
}

export default function EditTabs({
  label,
  sections,
  before,
}: {
  /** Accessible name of the tab bar. */
  label: string;
  sections: EditTabSection[];
  /** Banners and notes shown above every panel. */
  before?: ReactNode;
}) {
  const [active, setActive] = useState(sections[0]?.key ?? '');
  return (
    <>
      <div className="page-tabs">
        <div className="tabs" role="tablist" aria-label={label}>
          {sections.map((section) => (
            <button
              key={section.key}
              type="button"
              role="tab"
              id={`edit-tab-${section.key}`}
              aria-selected={section.key === active}
              aria-controls={`edit-panel-${section.key}`}
              onClick={() => setActive(section.key)}
            >
              {section.label}
              {section.count !== undefined ? (
                <span className="tabs-count">{section.count}</span>
              ) : null}
              {section.warn ? (
                <span className="agents-tab-warn" title={section.warnLabel ?? 'Hinweis'}>
                  <Icon name="warning" size={14} />
                  <span className="sr-only">{section.warnLabel ?? 'Hinweis'}</span>
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
      <div className="page-body">
        <div className="form-narrow">
          {before ? <div className="page-notices">{before}</div> : null}
          {sections.map((section) => (
            <div
              key={section.key}
              role="tabpanel"
              id={`edit-panel-${section.key}`}
              aria-labelledby={`edit-tab-${section.key}`}
              // hidden, not unmounted: the fields of every tab must be posted
              hidden={section.key !== active}
            >
              {section.content}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
