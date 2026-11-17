'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import Button from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';

/**
 * Two-step, password-gated delete for a knowledge base. The destructive submit
 * is hidden behind an explicit "arm" click and a current-password re-entry; the
 * server action (deleteKnowledgeBase) verifies the password before deleting.
 */

function ConfirmButton({ kbName }: { kbName: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" disabled={pending}>
      {pending ? 'Wird gelöscht …' : `„${kbName}“ endgültig löschen`}
    </Button>
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
      <div>
        <Button type="button" variant="danger" onClick={() => setArmed(true)}>
          „{kbName}“ löschen
        </Button>
      </div>
    );
  }

  return (
    <form className="stack" action={action}>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="id" value={kbId} />
      <Field label="Zur Bestätigung dein aktuelles Passwort" htmlFor={`kb-del-pw-${kbId}`}>
        <input
          id={`kb-del-pw-${kbId}`}
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="Aktuelles Passwort"
        />
      </Field>
      <div className="row">
        <ConfirmButton kbName={kbName} />
        <Button type="button" onClick={() => setArmed(false)}>
          Abbrechen
        </Button>
      </div>
    </form>
  );
}
