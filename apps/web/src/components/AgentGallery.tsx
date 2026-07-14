'use client';

import { useState, type ReactNode } from 'react';

export const NEW_AGENT_KEY = '__new';

export type AgentTileMeta = {
  id: string;
  name: string;
  /** German mode label, e.g. "Autopilot". */
  modeLabel: string;
  isActive: boolean;
  channelCount: number;
};

function AgentIcon() {
  // sparkle-in-a-head glyph — matches the nav "ai" sparkle family
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3a7 7 0 0 1 7 7v3.5a3.5 3.5 0 0 1-3.5 3.5H12l-3.5 3v-3.3A7 7 0 0 1 12 3Z" />
      <path d="M12 8l.9 2.1L15 11l-2.1.9L12 14l-.9-2.1L9 11l2.1-.9L12 8Z" />
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
 * Agent gallery: one tile per configured agent plus a "create" tile. Selecting
 * a tile reveals its server-rendered panel (edit form / create form).
 */
export default function AgentGallery({
  tiles,
  panels,
  newPanel,
}: {
  tiles: AgentTileMeta[];
  panels: Record<string, ReactNode>;
  newPanel: ReactNode;
}) {
  const [selected, setSelected] = useState<string>(tiles[0]?.id ?? NEW_AGENT_KEY);
  // Derive the effective selection: after a delete the stored id no longer
  // exists (soft navigation keeps useState) — fall back to the first remaining
  // agent, or the create panel, instead of a blank tabpanel.
  const effectiveSelected =
    selected === NEW_AGENT_KEY || tiles.some((t) => t.id === selected)
      ? selected
      : (tiles[0]?.id ?? NEW_AGENT_KEY);
  const activePanel = effectiveSelected === NEW_AGENT_KEY ? newPanel : panels[effectiveSelected];

  return (
    <>
      <div className="tile-grid" role="tablist" aria-label="Agenten">
        {tiles.map((agent) => {
          const isSelected = effectiveSelected === agent.id;
          return (
            <button
              key={agent.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => setSelected(agent.id)}
              className={`channel-tile${isSelected ? ' channel-tile--selected' : ''}${
                agent.isActive ? '' : ' channel-tile--off'
              }`}
            >
              <div className="tile-top">
                <span className="tile-icon tile-icon--agent">
                  <AgentIcon />
                </span>
                <span
                  className={`tile-status ${
                    agent.isActive ? 'tile-status--active' : 'tile-status--inactive'
                  }`}
                >
                  {agent.isActive ? 'Aktiv' : 'Pausiert'}
                </span>
              </div>
              <span className="tile-name">{agent.name}</span>
              <span className="tile-desc">
                {agent.modeLabel} ·{' '}
                {agent.channelCount === 1 ? '1 Kanal' : `${agent.channelCount} Kanäle`}
              </span>
            </button>
          );
        })}

        <button
          type="button"
          role="tab"
          aria-selected={effectiveSelected === NEW_AGENT_KEY}
          onClick={() => setSelected(NEW_AGENT_KEY)}
          className={`channel-tile channel-tile--new${
            effectiveSelected === NEW_AGENT_KEY ? ' channel-tile--selected' : ''
          }`}
        >
          <div className="tile-top">
            <span className="tile-icon tile-icon--new">
              <PlusIcon />
            </span>
          </div>
          <span className="tile-name">Neuer Agent</span>
          <span className="tile-desc">Identität, Verhalten und Kanäle festlegen.</span>
        </button>
      </div>

      <div role="tabpanel">{activePanel}</div>
    </>
  );
}
