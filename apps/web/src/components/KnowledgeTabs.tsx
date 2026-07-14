'use client';

import { useState, type ReactNode } from 'react';

export type KbTabKey = 'url' | 'file' | 'text';

function TabIcon({ tab }: { tab: KbTabKey }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (tab) {
    case 'url':
      return (
        <svg {...common}>
          <path d="M9 15a3 3 0 0 0 4.2 0l3-3a3 3 0 0 0-4.2-4.2l-.7.7" />
          <path d="M15 9a3 3 0 0 0-4.2 0l-3 3A3 3 0 0 0 12 16.2l.7-.7" />
        </svg>
      );
    case 'file':
      return (
        <svg {...common}>
          <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6Z" />
          <path d="M13 3v6h6" />
        </svg>
      );
    case 'text':
      return (
        <svg {...common}>
          <path d="M5 5h14M5 10h14M5 15h9M5 20h5" />
        </svg>
      );
  }
}

/**
 * Tabbed "add source" card for the knowledge base. Each tab's form is
 * server-rendered and passed in via `tabs[].panel`.
 */
export default function KnowledgeTabs({
  tabs,
}: {
  tabs: { key: KbTabKey; label: string; panel: ReactNode }[];
}) {
  const [active, setActive] = useState<KbTabKey>(tabs[0]?.key ?? 'url');
  const activePanel = tabs.find((t) => t.key === active)?.panel;

  return (
    <div className="panel">
      <h2>Quelle hinzufügen</h2>
      <div className="tabbar" role="tablist" aria-label="Quelle hinzufügen">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active === t.key}
            className={`tab${active === t.key ? ' tab--active' : ''}`}
            onClick={() => setActive(t.key)}
          >
            <TabIcon tab={t.key} />
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{activePanel}</div>
    </div>
  );
}
