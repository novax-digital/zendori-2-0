'use client';

import { useState, type ReactNode } from 'react';

export type TileKey = 'form' | 'email' | 'whatsapp' | 'voice' | 'chat' | 'test';

export type TileMeta = {
  key: TileKey;
  name: string;
  description: string;
  /** number of active channels of this category */
  activeCount: number;
  /** total configured channels of this category */
  totalCount: number;
};

function TileIcon({ tile }: { tile: TileKey }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (tile) {
    case 'form':
      return (
        <svg {...common}>
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <path d="M9 8h6M9 12h6M9 16h3" />
        </svg>
      );
    case 'email':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m4 7 8 6 8-6" />
        </svg>
      );
    case 'whatsapp':
      return (
        <svg {...common}>
          <path d="M4 20l1.4-4A7.5 7.5 0 1 1 8 18.6L4 20Z" />
          <path d="M9.2 9c-.3 1.4 1 3.4 2.2 4.4 1.3 1 2.6 1.2 3.4.9" />
        </svg>
      );
    case 'voice':
      return (
        <svg {...common}>
          <path d="M5 4h3l1.5 4.5L7.5 10a11 11 0 0 0 6 6l1.5-2 4.5 1.5V19a2 2 0 0 1-2.2 2A16 16 0 0 1 3 6.2 2 2 0 0 1 5 4Z" />
        </svg>
      );
    case 'chat':
      return (
        <svg {...common}>
          <path d="M5 5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 4V7a2 2 0 0 1 2-2Z" />
          <path d="M8.5 10h7M8.5 13h4" />
        </svg>
      );
    case 'test':
      return (
        <svg {...common}>
          <path d="M9 3h6M10 3v6l-4.5 8A2 2 0 0 0 7.3 20h9.4a2 2 0 0 0 1.8-3L14 9V3" />
          <path d="M8 15h8" />
        </svg>
      );
  }
}

function statusFor(meta: TileMeta): { cls: string; label: string } {
  if (meta.totalCount === 0) return { cls: 'tile-status--empty', label: 'Nicht eingerichtet' };
  if (meta.activeCount > 0) return { cls: 'tile-status--active', label: `${meta.activeCount} aktiv` };
  return { cls: 'tile-status--inactive', label: 'Inaktiv' };
}

/**
 * Channel gallery: a grid of channel-type tiles. Selecting a tile reveals its
 * configuration panel (server-rendered, passed in via `panels`). The default
 * selection is the first tile that already has a configured channel.
 */
export default function ChannelGallery({
  tiles,
  panels,
}: {
  tiles: TileMeta[];
  panels: Record<TileKey, ReactNode>;
}) {
  const firstConfigured = tiles.find((t) => t.totalCount > 0)?.key;
  const [selected, setSelected] = useState<TileKey>(firstConfigured ?? tiles[0]?.key ?? 'form');

  return (
    <>
      <div className="tile-grid" role="tablist" aria-label="Kanäle">
        {tiles.map((meta) => {
          const status = statusFor(meta);
          const isSelected = selected === meta.key;
          return (
            <button
              key={meta.key}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => setSelected(meta.key)}
              className={`channel-tile${isSelected ? ' channel-tile--selected' : ''}${
                meta.totalCount === 0 ? ' channel-tile--off' : ''
              }`}
            >
              <div className="tile-top">
                <span className={`tile-icon tile-icon--${meta.key}`}>
                  <TileIcon tile={meta.key} />
                </span>
                <span className={`tile-status ${status.cls}`}>{status.label}</span>
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
