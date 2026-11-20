'use client';

// Auth block of an API connection (Phase 13): the fields depend on the chosen
// kind, so the choice is client state. All inputs stay plain form fields of the
// surrounding server-action form.
import { useState } from 'react';
import { Field } from '@/components/ui/Field';
import { AUTH_KIND_LABELS } from '@/lib/api-integration/labels';

type AuthKind = 'none' | 'bearer' | 'header' | 'basic';

export default function ApiAuthFields({
  idPrefix,
  defaultKind = 'none',
  defaultHeaderName = '',
  defaultUsername = '',
  /** True when a secret is already stored for `defaultKind` (edit form). */
  hasStoredSecret = false,
}: {
  idPrefix: string;
  defaultKind?: AuthKind;
  defaultHeaderName?: string;
  defaultUsername?: string;
  hasStoredSecret?: boolean;
}) {
  const [kind, setKind] = useState<AuthKind>(defaultKind);
  const keepsSecret = hasStoredSecret && kind === defaultKind;
  const secretLabel =
    kind === 'bearer' ? 'Token' : kind === 'header' ? 'API-Schlüssel' : 'Passwort';

  return (
    <>
      <Field
        label="Anmeldung am Endsystem"
        htmlFor={`${idPrefix}-auth-kind`}
        help="So meldet sich Zendori bei jedem Aufruf an. Das Geheimnis wird verschlüsselt gespeichert und nie wieder angezeigt."
      >
        <select
          id={`${idPrefix}-auth-kind`}
          name="authKind"
          value={kind}
          onChange={(event) => setKind(event.target.value as AuthKind)}
        >
          {(Object.keys(AUTH_KIND_LABELS) as AuthKind[]).map((value) => (
            <option key={value} value={value}>
              {AUTH_KIND_LABELS[value]}
            </option>
          ))}
        </select>
      </Field>

      {kind === 'header' ? (
        <Field label="Header-Name" htmlFor={`${idPrefix}-auth-header`}>
          <input
            id={`${idPrefix}-auth-header`}
            name="headerName"
            type="text"
            required
            maxLength={64}
            defaultValue={defaultHeaderName}
            placeholder="X-API-Key"
            autoComplete="off"
          />
        </Field>
      ) : null}

      {kind === 'basic' ? (
        <Field label="Benutzername" htmlFor={`${idPrefix}-auth-user`}>
          <input
            id={`${idPrefix}-auth-user`}
            name="username"
            type="text"
            required
            maxLength={200}
            defaultValue={defaultUsername}
            autoComplete="off"
          />
        </Field>
      ) : null}

      {kind !== 'none' ? (
        <Field
          label={secretLabel}
          htmlFor={`${idPrefix}-auth-secret`}
          help={keepsSecret ? 'Leer lassen, um das gespeicherte Geheimnis zu behalten.' : undefined}
        >
          <input
            id={`${idPrefix}-auth-secret`}
            name="secret"
            type="password"
            required={!keepsSecret}
            maxLength={4000}
            autoComplete="off"
            placeholder={keepsSecret ? '•••••••• (gespeichert)' : ''}
          />
        </Field>
      ) : null}
    </>
  );
}
