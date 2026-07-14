'use client';

import { useState, type ReactNode } from 'react';

export const NEW_KB_KEY = '__new';

export type KbTileMeta = {
  id: string;
  name: string;
  description: string | null;
  sourceCount: number;
  agentCount: number;
};

function KbIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/**
 * Knowledge-base gallery: one tile per base plus a create tile. Selecting a
 * tile reveals its server-rendered panel (sources + add forms / create form).
 */
export default function KbGallery({
  tiles,
  panels,
  newPanel,
}: {
  tiles: KbTileMeta[];
  panels: Record<string, ReactNode>;
  newPanel: ReactNode;
}) {
  const [selected, setSelected] = useState<string>(tiles[0]?.id ?? NEW_KB_KEY);
  // After a delete the stored id may be gone (soft navigation keeps state) —
  // fall back to the first remaining base or the create panel.
  const effectiveSelected =
    selected === NEW_KB_KEY || tiles.some((t) => t.id === selected)
      ? selected
      : (tiles[0]?.id ?? NEW_KB_KEY);
  const activePanel = effectiveSelected === NEW_KB_KEY ? newPanel : panels[effectiveSelected];

  return (
    <>
      <div className="tile-grid" role="tablist" aria-label="Wissensdatenbanken">
        {tiles.map((kb) => {
          const isSelected = effectiveSelected === kb.id;
          return (
            <button
              key={kb.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => setSelected(kb.id)}
              className={`channel-tile${isSelected ? ' channel-tile--selected' : ''}`}
            >
              <div className="tile-top">
                <span className="tile-icon tile-icon--email">
                  <KbIcon />
                </span>
                <span
                  className={`tile-status ${
                    kb.sourceCount > 0 ? 'tile-status--active' : 'tile-status--empty'
                  }`}
                >
                  {kb.sourceCount === 1 ? '1 Quelle' : `${kb.sourceCount} Quellen`}
                </span>
              </div>
              <span className="tile-name">{kb.name}</span>
              <span className="tile-desc">
                {kb.description?.trim() ||
                  (kb.agentCount === 1
                    ? 'Mit 1 Agent verknüpft.'
                    : `Mit ${kb.agentCount} Agenten verknüpft.`)}
              </span>
            </button>
          );
        })}

        <button
          type="button"
          role="tab"
          aria-selected={effectiveSelected === NEW_KB_KEY}
          onClick={() => setSelected(NEW_KB_KEY)}
          className={`channel-tile channel-tile--new${
            effectiveSelected === NEW_KB_KEY ? ' channel-tile--selected' : ''
          }`}
        >
          <div className="tile-top">
            <span className="tile-icon tile-icon--new">
              <PlusIcon />
            </span>
          </div>
          <span className="tile-name">Neue Wissensdatenbank</span>
          <span className="tile-desc">Quellen bündeln und Agenten zuordnen.</span>
        </button>
      </div>

      <div role="tabpanel">{activePanel}</div>
    </>
  );
}
