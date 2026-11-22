'use client';

// Kind + address of a NEW connection (Phase 14a). The address field depends on
// the kind (a REST base URL vs. the endpoint of an MCP server), so the choice is
// client state. Both stay plain fields of the surrounding server-action form.
// Before migration 0039 only REST connections exist — the kind select is hidden.
import { useState } from 'react';
import { Field } from '@/components/ui/Field';
import { CONNECTION_KIND_LABELS } from '@/lib/api-integration/labels';

type Kind = 'http' | 'mcp';

export default function ConnectionKindFields({
  idPrefix,
  mcpAvailable,
}: {
  idPrefix: string;
  mcpAvailable: boolean;
}) {
  const [kind, setKind] = useState<Kind>('http');
  const isMcp = kind === 'mcp';

  return (
    <>
      {mcpAvailable ? (
        <Field
          label="Art der Verbindung"
          htmlFor={`${idPrefix}-kind`}
          help={
            isMcp
              ? 'Zendori liest die Werkzeuge des Servers aus. Du wählst, welche davon Aktionen für deine Agenten werden.'
              : 'Du beschreibst jeden Aufruf deines Systems selbst als Aktion.'
          }
        >
          <select
            id={`${idPrefix}-kind`}
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as Kind)}
          >
            {(Object.keys(CONNECTION_KIND_LABELS) as Kind[]).map((value) => (
              <option key={value} value={value}>
                {CONNECTION_KIND_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <Field
        label={isMcp ? 'Adresse des MCP-Servers' : 'Basis-URL'}
        htmlFor={`${idPrefix}-url`}
        help={
          isMcp
            ? 'Die vollständige Adresse des Endpunkts, nur https. Meist endet sie auf „/mcp“. Unterstützt wird der Transport „Streamable HTTP“.'
            : 'Adresse der API ohne einzelne Endpunkte, nur https. Die Pfade legst du pro Aktion fest.'
        }
      >
        <input
          id={`${idPrefix}-url`}
          name="baseUrl"
          type="url"
          required
          maxLength={500}
          placeholder={isMcp ? 'https://mcp.example.com/mcp' : 'https://api.example.com/v1'}
        />
      </Field>
    </>
  );
}
