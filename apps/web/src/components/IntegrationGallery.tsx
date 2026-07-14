'use client';

import { useState, type ReactNode } from 'react';

export type IntegrationKey = 'hubspot';

export type IntegrationStatus = 'active' | 'inactive' | 'disconnected';

export type IntegrationTileMeta = {
  key: IntegrationKey;
  name: string;
  description: string;
  status: IntegrationStatus;
};

function IntegrationIcon({ integration }: { integration: IntegrationKey }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (integration) {
    case 'hubspot':
      // stylised sprocket/hub — matches the "integrations" nav glyph
      return (
        <svg {...common}>
          <circle cx="7" cy="17" r="3" />
          <path d="M16 3v6M16 9a4 4 0 1 1-4 4" />
          <path d="M16 9V6M16 6h.01" />
          <circle cx="16" cy="4" r="1.4" />
        </svg>
      );
  }
}

const STATUS_LABEL: Record<IntegrationStatus, string> = {
  active: 'Aktiv',
  inactive: 'Verbunden · inaktiv',
  disconnected: 'Nicht verbunden',
};

const STATUS_CLASS: Record<IntegrationStatus, string> = {
  active: 'tile-status--active',
  inactive: 'tile-status--inactive',
  disconnected: 'tile-status--empty',
};

/**
 * Integration gallery: a grid of integration tiles. Selecting a tile reveals its
 * configuration panel (server-rendered, passed in via `panels`).
 */
export default function IntegrationGallery({
  tiles,
  panels,
}: {
  tiles: IntegrationTileMeta[];
  panels: Record<IntegrationKey, ReactNode>;
}) {
  const [selected, setSelected] = useState<IntegrationKey>(tiles[0]?.key ?? 'hubspot');

  return (
    <>
      <div className="tile-grid" role="tablist" aria-label="Integrationen">
        {tiles.map((meta) => {
          const isSelected = selected === meta.key;
          return (
            <button
              key={meta.key}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => setSelected(meta.key)}
              className={`channel-tile${isSelected ? ' channel-tile--selected' : ''}${
                meta.status === 'disconnected' ? ' channel-tile--off' : ''
              }`}
            >
              <div className="tile-top">
                <span className={`tile-icon tile-icon--${meta.key}`}>
                  <IntegrationIcon integration={meta.key} />
                </span>
                <span className={`tile-status ${STATUS_CLASS[meta.status]}`}>
                  {STATUS_LABEL[meta.status]}
                </span>
              </div>
              <span className="tile-name">{meta.name}</span>
              <span className="tile-desc">{meta.description}</span>
            </button>
          );
        })}
      </div>

      <div role="tabpanel">{panels[selected]}</div>
    </>
  );
}
