'use client';

import { useState } from 'react';

/**
 * Two-step delete confirmation (DangerDeleteKb arm pattern without the
 * password): first click arms, then an explicit danger button submits the
 * surrounding server-action form; Abbrechen disarms. Protects destructive
 * one-click deletes (e.g. agents) from slips.
 *
 * `inMenu`: render as entries of a <Menu> (components/ui/Menu) — the usual
 * place for a delete since the redesign:
 *   <Menu>
 *     <form action={deleteAgent}>
 *       <input type="hidden" name="agentId" value={agent.id} />
 *       <ConfirmDeleteButton inMenu label="Agent löschen" confirmLabel="Endgültig löschen" />
 *     </form>
 *   </Menu>
 */
export default function ConfirmDeleteButton({
  label,
  confirmLabel,
  inMenu = false,
}: {
  label: string;
  confirmLabel: string;
  inMenu?: boolean;
}) {
  const [armed, setArmed] = useState(false);

  if (inMenu) {
    if (!armed) {
      return (
        <button className="menu-item menu-item--danger" type="button" onClick={() => setArmed(true)}>
          <span className="menu-label">{label}</span>
        </button>
      );
    }
    return (
      <>
        <button className="menu-item menu-item--danger" type="submit">
          <span className="menu-label">{confirmLabel}</span>
        </button>
        <button className="menu-item" type="button" onClick={() => setArmed(false)}>
          <span className="menu-label">Abbrechen</span>
        </button>
      </>
    );
  }

  if (!armed) {
    return (
      <button className="btn btn--secondary" type="button" onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="row">
      <button className="btn btn--danger" type="submit">
        {confirmLabel}
      </button>
      <button className="btn btn--secondary" type="button" onClick={() => setArmed(false)}>
        Abbrechen
      </button>
    </span>
  );
}
