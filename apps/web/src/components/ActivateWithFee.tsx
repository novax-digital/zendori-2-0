'use client';

import { useState } from 'react';

/**
 * The switch of an INACTIVE channel whose kind costs a monthly fee (migration
 * 0045): the first click does not activate, it says what the channel will cost;
 * only "Kostenpflichtig aktivieren" submits the surrounding server-action form.
 * The hidden `confirmFee` field is what the action insists on — activating a
 * paid channel without it is refused, so the fee is never started by a slip.
 */
export default function ActivateWithFee({ feeText }: { feeText: string }) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={false}
        aria-label="Kanal aktiv"
        className="switch-btn"
        title={`Inaktiv — aktivieren kostet ${feeText} pro Monat`}
        onClick={() => setArmed(true)}
      />
    );
  }
  return (
    <span className="fee-confirm" role="group" aria-label="Kostenpflichtig aktivieren">
      <span className="fee-confirm-text">
        Aktiv kostet dieser Kanal <strong>{feeText} pro Monat</strong> (netto), für jeden Monat, in
        dem er aktiv ist.
      </span>
      <span className="row">
        <input type="hidden" name="confirmFee" value="1" />
        <button className="btn btn--primary btn--sm" type="submit">
          Kostenpflichtig aktivieren
        </button>
        <button className="btn btn--secondary btn--sm" type="button" onClick={() => setArmed(false)}>
          Abbrechen
        </button>
      </span>
    </span>
  );
}
