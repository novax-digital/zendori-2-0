'use client';

// Generic in-form tab switcher (agents editor, 2026-07-24): sections stay
// MOUNTED and are only visually hidden, so all form fields keep submitting with
// the surrounding <form> (the FormBuilder always-mounted-hidden pattern).
// Buttons are type="button" so switching tabs never submits.
import { useState, type ReactNode } from 'react';

export interface EditTabSection {
  key: string;
  label: string;
  /** Optional warning marker shown on the tab (e.g. missing knowledge base). */
  warn?: boolean;
  content: ReactNode;
}

export default function EditTabs({ sections }: { sections: EditTabSection[] }) {
  const [active, setActive] = useState(sections[0]?.key ?? '');
  return (
    <div>
      <div className="tabbar" style={{ marginBottom: '1rem' }}>
        {sections.map((section) => (
          <button
            key={section.key}
            type="button"
            className={`tab${section.key === active ? ' tab--active' : ''}`}
            onClick={() => setActive(section.key)}
          >
            {section.label}
            {section.warn ? <span aria-hidden="true"> ⚠</span> : null}
          </button>
        ))}
      </div>
      {sections.map((section) => (
        <div key={section.key} style={section.key === active ? undefined : { display: 'none' }}>
          {section.content}
        </div>
      ))}
    </div>
  );
}
