'use client';

// Owner-only delete of a builder form (opened via ?panel=delete from the page
// head's menu). Same arm flow as before the redesign: the danger button stays
// disabled until the form name is typed — deleting also removes the form's
// conversations, so a slip must be impossible.
import { useState } from 'react';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { deleteForm } from '../actions';

export default function DeleteFormDrawer({
  orgId,
  formId,
  formName,
  closeHref,
}: {
  orgId: string;
  formId: string;
  formName: string;
  closeHref: string;
}) {
  const [typed, setTyped] = useState('');

  return (
    <Drawer
      title="Formular löschen"
      closeHref={closeHref}
      footer={
        <>
          <Button href={closeHref} scroll={false}>
            Abbrechen
          </Button>
          <Button type="submit" form="delete-form" variant="danger" disabled={typed !== formName}>
            Endgültig löschen
          </Button>
        </>
      }
    >
      <Callout tone="danger">
        Löscht das Formular und alle zugehörigen Konversationen unwiderruflich.
      </Callout>
      <form id="delete-form" className="stack" action={deleteForm}>
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="formId" value={formId} />
        <Field
          label="Formular-Name zur Bestätigung"
          htmlFor="delete-form-name"
          help={`Tippe „${formName}“ ein, um das Löschen freizugeben.`}
        >
          <input
            id="delete-form-name"
            type="text"
            autoComplete="off"
            placeholder={formName}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </Field>
      </form>
    </Drawer>
  );
}
