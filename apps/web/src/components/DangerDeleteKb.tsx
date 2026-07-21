'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * Two-step, password-gated delete for a knowledge base. The destructive submit
 * is hidden behind an explicit "arm" click and a current-password re-entry; the
 * server action (deleteKnowledgeBase) verifies the password before deleting.
 */

function ConfirmButton({ kbName }: { kbName: string }) {
  const { pending } = useFormStatus();
  return (
    <button className="danger" type="submit" disabled={pending}>
      {pending ? 'Wird gelöscht…' : `„${kbName}" endgültig löschen`}
    </button>
  );
}

export default function DangerDeleteKb({
  org,
  kbId,
  kbName,
  action,
}: {
  org: string;
  kbId: string;
  kbName: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button className="ghost kb-delete-arm" type="button" onClick={() => setArmed(true)}>
        „{kbName}" löschen
      </button>
    );
  }

  return (
    <form className="stack" action={action} style={{ maxWidth: '28rem' }}>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="id" value={kbId} />
      <div>
        <label htmlFor={`kb-del-pw-${kbId}`}>Zur Bestätigung dein aktuelles Passwort</label>
        <input
          id={`kb-del-pw-${kbId}`}
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="Aktuelles Passwort"
        />
      </div>
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
        <ConfirmButton kbName={kbName} />
        <button className="ghost" type="button" onClick={() => setArmed(false)}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}
