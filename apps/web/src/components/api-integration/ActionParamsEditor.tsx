'use client';

// Parameter list of a data action (Phase 13). The rows are client state; the
// surrounding server-action form receives them as ONE hidden JSON field
// ("parameters"), which the server validates with dataActionParametersSchema —
// nothing here is trusted. Type-only import from core (no value imports in
// client components).
//
// mode="mcp" (Phase 14a): the parameters are the arguments of an imported MCP
// tool. There is no path or query — every parameter is an argument (`in: body`),
// and the optional second name is its path inside the argument object.
import { useState } from 'react';
import type { DataActionParameter } from '@zendori/core';
import Button from '@/components/ui/Button';
import { CONTEXT_KEY_LABELS } from '@/lib/api-integration/labels';

type Row = {
  uid: number;
  key: string;
  in: DataActionParameter['in'];
  source: DataActionParameter['source'];
  type: DataActionParameter['type'];
  required: boolean;
  description: string;
  field: string;
  options: string;
  contextKey: string;
  fixedValue: string;
};

const MAX_ROWS = 20;

function toRow(param: DataActionParameter, uid: number): Row {
  return {
    uid,
    key: param.key,
    in: param.in,
    source: param.source,
    type: param.type,
    required: param.required,
    description: param.description,
    field: param.field ?? '',
    options: (param.options ?? []).join(', '),
    contextKey: param.contextKey ?? 'contact.email',
    fixedValue: param.fixedValue ?? '',
  };
}

function emptyRow(uid: number, mode: 'http' | 'mcp'): Row {
  return {
    uid,
    key: '',
    in: mode === 'mcp' ? 'body' : 'query',
    source: 'agent',
    type: 'string',
    required: true,
    description: '',
    field: '',
    options: '',
    contextKey: 'contact.email',
    fixedValue: '',
  };
}

/** Rows → the JSON the server parses (empty optional fields are left out). */
function serialize(rows: Row[]): string {
  return JSON.stringify(
    rows.map((row) => {
      const options = row.options
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
      return {
        key: row.key.trim(),
        in: row.in,
        source: row.source,
        type: row.source === 'context' ? 'string' : row.type,
        // a path segment can never be left out
        required: row.in === 'path' ? true : row.required,
        description: row.source === 'agent' ? row.description.trim() : '',
        ...(row.in !== 'path' && row.field.trim() !== '' ? { field: row.field.trim() } : {}),
        ...(row.source === 'agent' && row.type === 'string' && options.length > 0
          ? { options }
          : {}),
        ...(row.source === 'context' ? { contextKey: row.contextKey } : {}),
        ...(row.source === 'fixed' ? { fixedValue: row.fixedValue } : {}),
      };
    })
  );
}

export default function ActionParamsEditor({
  initial,
  disabled = false,
  mode = 'http',
}: {
  initial: DataActionParameter[];
  disabled?: boolean;
  /** 'mcp' = arguments of an imported MCP tool (no path/query). */
  mode?: 'http' | 'mcp';
}) {
  const isMcp = mode === 'mcp';
  const [rows, setRows] = useState<Row[]>(() => initial.map((param, index) => toRow(param, index)));
  const [nextUid, setNextUid] = useState(initial.length);

  const update = (uid: number, patch: Partial<Row>): void => {
    setRows((current) => current.map((row) => (row.uid === uid ? { ...row, ...patch } : row)));
  };
  const remove = (uid: number): void => {
    setRows((current) => current.filter((row) => row.uid !== uid));
  };
  const add = (): void => {
    setRows((current) => [...current, emptyRow(nextUid, mode)]);
    setNextUid((value) => value + 1);
  };

  return (
    <div className="stack">
      <input type="hidden" name="parameters" value={serialize(rows)} />
      {rows.length === 0 ? (
        <p className="muted small">
          {isMcp
            ? 'Keine Parameter: Das Werkzeug wird ohne Argumente aufgerufen.'
            : 'Noch keine Parameter. Ohne Parameter ruft die Aktion immer dieselbe Adresse auf.'}
        </p>
      ) : null}

      {rows.map((row, index) => {
        const id = `param-${row.uid}`;
        return (
          <fieldset key={row.uid} className="param-card" disabled={disabled}>
            <legend className="sr-only">Parameter {index + 1}</legend>
            <div className="field-row">
              <div className="field">
                <label htmlFor={`${id}-key`}>Name</label>
                <input
                  id={`${id}-key`}
                  type="text"
                  className="mono"
                  value={row.key}
                  maxLength={40}
                  placeholder="order_id"
                  onChange={(event) => update(row.uid, { key: event.target.value })}
                />
              </div>
              {isMcp ? null : (
                <div className="field">
                  <label htmlFor={`${id}-in`}>Ort im Aufruf</label>
                  <select
                    id={`${id}-in`}
                    value={row.in}
                    onChange={(event) => update(row.uid, { in: event.target.value as Row['in'] })}
                  >
                    <option value="path">Pfad ({'{name}'})</option>
                    <option value="query">Query (?name=…)</option>
                    <option value="body">Body (JSON)</option>
                  </select>
                </div>
              )}
              <div className="field">
                <label htmlFor={`${id}-source`}>Woher kommt der Wert?</label>
                <select
                  id={`${id}-source`}
                  value={row.source}
                  onChange={(event) =>
                    update(row.uid, { source: event.target.value as Row['source'] })
                  }
                >
                  <option value="agent">KI-Agent (aus dem Gespräch)</option>
                  <option value="context">Kontext (von Zendori gesetzt)</option>
                  <option value="fixed">Fester Wert</option>
                </select>
              </div>
            </div>

            {row.source === 'agent' ? (
              <>
                <div className="field-row">
                  <div className="field">
                    <label htmlFor={`${id}-type`}>Typ</label>
                    <select
                      id={`${id}-type`}
                      value={row.type}
                      onChange={(event) =>
                        update(row.uid, { type: event.target.value as Row['type'] })
                      }
                    >
                      <option value="string">Text</option>
                      <option value="integer">Ganze Zahl</option>
                      <option value="number">Zahl</option>
                      <option value="boolean">Ja/Nein</option>
                    </select>
                  </div>
                  {row.type === 'string' ? (
                    <div className="field">
                      <label htmlFor={`${id}-options`}>Erlaubte Werte (optional)</label>
                      <input
                        id={`${id}-options`}
                        type="text"
                        value={row.options}
                        placeholder="offen, versendet, storniert"
                        onChange={(event) => update(row.uid, { options: event.target.value })}
                      />
                    </div>
                  ) : null}
                </div>
                <div className="field">
                  <label htmlFor={`${id}-description`}>Hinweis für den Agenten</label>
                  <input
                    id={`${id}-description`}
                    type="text"
                    value={row.description}
                    maxLength={300}
                    placeholder="Bestellnummer, wie der Kunde sie nennt, z. B. 4711-22"
                    onChange={(event) => update(row.uid, { description: event.target.value })}
                  />
                </div>
              </>
            ) : null}

            {row.source === 'context' ? (
              <div className="field">
                <label htmlFor={`${id}-context`}>Kontextwert</label>
                <select
                  id={`${id}-context`}
                  value={row.contextKey}
                  onChange={(event) => update(row.uid, { contextKey: event.target.value })}
                >
                  {Object.entries(CONTEXT_KEY_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <p className="field-help">
                  Zendori setzt diesen Wert selbst aus der Konversation. Der Agent kann ihn nicht
                  verändern — so fragt er nie Daten fremder Kunden ab.
                </p>
              </div>
            ) : null}

            {row.source === 'fixed' ? (
              <div className="field-row">
                <div className="field">
                  <label htmlFor={`${id}-fixed`}>Wert</label>
                  <input
                    id={`${id}-fixed`}
                    type="text"
                    value={row.fixedValue}
                    maxLength={500}
                    onChange={(event) => update(row.uid, { fixedValue: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${id}-fixed-type`}>Typ</label>
                  <select
                    id={`${id}-fixed-type`}
                    value={row.type}
                    onChange={(event) =>
                      update(row.uid, { type: event.target.value as Row['type'] })
                    }
                  >
                    <option value="string">Text</option>
                    <option value="integer">Ganze Zahl</option>
                    <option value="number">Zahl</option>
                    <option value="boolean">Ja/Nein</option>
                  </select>
                </div>
              </div>
            ) : null}

            <div className="row row--between">
              <div className="row">
                {row.in !== 'path' ? (
                  <>
                    <label className="check-row" htmlFor={`${id}-required`}>
                      <input
                        id={`${id}-required`}
                        type="checkbox"
                        checked={row.required}
                        onChange={(event) => update(row.uid, { required: event.target.checked })}
                      />
                      Pflicht
                    </label>
                    <input
                      type="text"
                      className="mono param-field-name"
                      aria-label={
                        isMcp
                          ? 'Name des Arguments im Werkzeug, falls er vom Namen oben abweicht'
                          : 'Abweichender Name im Aufruf (optional)'
                      }
                      value={row.field}
                      maxLength={120}
                      placeholder={
                        isMcp
                          ? 'Argument im Werkzeug, z. B. customer.email'
                          : row.in === 'body'
                            ? 'Name im Body, z. B. customer.email'
                            : 'Name in der Query'
                      }
                      onChange={(event) => update(row.uid, { field: event.target.value })}
                    />
                  </>
                ) : (
                  <span className="muted small">Pfad-Parameter sind immer Pflicht.</span>
                )}
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => remove(row.uid)}>
                Entfernen
              </Button>
            </div>
          </fieldset>
        );
      })}

      {!disabled && rows.length < MAX_ROWS ? (
        <div>
          <Button type="button" size="sm" icon="plus" onClick={add}>
            Parameter hinzufügen
          </Button>
        </div>
      ) : null}
    </div>
  );
}
