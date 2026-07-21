'use client';

import { useState } from 'react';

/**
 * Two-step delete confirmation (DangerDeleteKb arm pattern without the
 * password): first click arms, then an explicit danger button submits the
 * surrounding server-action form; Abbrechen disarms. Protects destructive
 * one-click deletes (e.g. agents) from slips.
 */
export default function ConfirmDeleteButton({
  label,
  confirmLabel,
}: {
  label: string;
  confirmLabel: string;
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button className="ghost" type="button" onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
      <button className="danger" type="submit">
        {confirmLabel}
      </button>
      <button className="ghost" type="button" onClick={() => setArmed(false)}>
        Abbrechen
      </button>
    </span>
  );
}
