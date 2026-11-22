// "Werkzeuge" tab of an MCP connection (Phase 14a). Server component: it shows
// the snapshot of the server's tool list the WORKER stored (the web app never
// calls a customer's server), lets the owner import single tools as actions and
// flags imported actions whose tool changed or disappeared since the import.
import Link from 'next/link';
import { convertMcpInputSchema, type McpCatalog } from '@zendori/core';
import { href } from '@/lib/href';
import {
  MCP_IMPORT_ISSUE_LABELS,
  formatDateTime,
  mcpSyncErrorText,
} from '@/lib/api-integration/labels';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { EmptyState, Section } from '@/components/ui/Layout';
import { importMcpTool, requestMcpSync } from '@/app/settings/integrations/api/actions';
import McpSyncPoller from './McpSyncPoller';

export interface McpActionRow {
  id: string;
  name: string;
  label: string;
  kind: string;
  requires_confirmation: boolean;
  is_active: boolean;
  mcp_tool_name: string | null;
  mcp_drift: string | null;
}

/** Badge for an imported action whose tool no longer matches the import. */
export function McpDriftBadge({ drift }: { drift: string | null }) {
  if (drift === 'changed') return <Badge tone="warn">Vom Server geändert</Badge>;
  if (drift === 'missing') return <Badge tone="danger">Fehlt auf dem Server</Badge>;
  return null;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export default function McpToolsTab({
  orgId,
  connectionId,
  selfPath,
  sync,
  catalog,
  actions,
}: {
  orgId: string;
  connectionId: string;
  /** Path of the connection page (links to the action editor hang below it). */
  selfPath: string;
  sync: { pending: boolean; syncedAt: string | null; error: string | null };
  catalog: McpCatalog | null;
  actions: McpActionRow[];
}) {
  const imported = new Map(
    actions.filter((action) => action.mcp_tool_name).map((action) => [action.mcp_tool_name, action])
  );
  const actionHref = (id: string): string => href(`${selfPath}/actions/${id}`, { org: orgId });

  const refresh = (
    <form action={requestMcpSync}>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="connectionId" value={connectionId} />
      <Button type="submit" size="sm" disabled={sync.pending}>
        Werkzeugliste aktualisieren
      </Button>
    </form>
  );

  return (
    <>
      {sync.pending ? <McpSyncPoller orgId={orgId} connectionId={connectionId} /> : null}

      {!sync.pending && sync.error ? (
        <Callout tone="danger" title="Die Werkzeugliste konnte nicht gelesen werden">
          {mcpSyncErrorText(sync.error)} Letzter Versuch: {formatDateTime(sync.syncedAt)}.
          {catalog ? ' Unten steht die zuletzt gelesene Liste.' : ''}
        </Callout>
      ) : null}

      <Section
        title="Importierte Aktionen"
        help="Diese Werkzeuge stehen als Aktionen zur Verfügung. Welcher Agent welche Aktion nutzen darf, legst du am Agenten fest."
      >
        {actions.length === 0 ? (
          <EmptyState
            title="Noch nichts importiert"
            text="Importiere unten die Werkzeuge, die deine Agenten nutzen sollen."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Aktion</th>
                  <th>Werkzeug auf dem Server</th>
                  <th>Art</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((action) => (
                  <tr key={action.id}>
                    <td>
                      <div className="cell-title">
                        <Link href={actionHref(action.id)}>{action.label}</Link>
                      </div>
                      <div className="cell-sub mono">{action.name}</div>
                    </td>
                    <td className="mono small">{action.mcp_tool_name ?? '—'}</td>
                    <td>
                      {action.kind === 'write' ? (
                        <Badge tone={action.requires_confirmation ? 'warn' : 'accent'}>
                          {action.requires_confirmation ? 'Schreibt, mit Bestätigung' : 'Schreibt'}
                        </Badge>
                      ) : (
                        <Badge>Liest</Badge>
                      )}
                    </td>
                    <td>
                      <div className="row">
                        {action.is_active ? (
                          <Badge tone="success" dot>
                            Aktiv
                          </Badge>
                        ) : (
                          <Badge tone="muted" dot>
                            Pausiert
                          </Badge>
                        )}
                        <McpDriftBadge drift={action.mcp_drift} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Werkzeuge des Servers"
        help={
          catalog ? (
            <>
              {catalog.server.name || 'MCP-Server'}
              {catalog.server.version ? ` ${catalog.server.version}` : ''} · Protokoll{' '}
              {catalog.server.protocolVersion} · gelesen {formatDateTime(sync.syncedAt)}. Zendori
              prüft die Liste täglich auf Änderungen.
            </>
          ) : (
            'Zendori liest die Liste über den Worker, also von einer festen IP-Adresse.'
          )
        }
        actions={refresh}
      >
        {!catalog ? (
          sync.pending ? null : (
            <EmptyState
              title="Noch keine Werkzeugliste"
              text="Prüfe Adresse und Anmeldung unter „Verbindung“ und aktualisiere die Liste."
            />
          )
        ) : catalog.tools.length === 0 ? (
          <EmptyState title="Der Server bietet keine Werkzeuge an" />
        ) : (
          <>
            <Callout>
              Importiere nur, was deine Agenten brauchen. Beim Import entsteht eine Aktion mit einer
              Kopie von Beschreibung und Argumenten, die du prüfst und anpasst. Der Agent sieht nur
              diese Kopie — ändert der Server das Werkzeug später, bleibt deine Fassung gültig und
              Zendori weist dich auf die Änderung hin.
            </Callout>
            {catalog.truncated ? (
              <Callout tone="warn">
                Der Server bietet mehr Werkzeuge an, als Zendori anzeigt. Hier stehen die ersten{' '}
                {catalog.tools.length}.
              </Callout>
            ) : null}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Werkzeug</th>
                    <th>Laut Server</th>
                    <th aria-label="Import" />
                  </tr>
                </thead>
                <tbody>
                  {catalog.tools.map((tool) => {
                    const action = imported.get(tool.name);
                    const convertible = convertMcpInputSchema(tool.inputSchema);
                    return (
                      <tr key={tool.name}>
                        <td>
                          <div className="cell-title">{tool.title ?? tool.name}</div>
                          <div className="cell-sub mono">{tool.name}</div>
                          {tool.description ? (
                            <div className="cell-sub">{clip(tool.description, 220)}</div>
                          ) : null}
                        </td>
                        <td>
                          <div className="row">
                            {tool.readOnlyHint === true ? <Badge>Liest</Badge> : null}
                            {tool.destructiveHint === true ? (
                              <Badge tone="warn">Kann löschen</Badge>
                            ) : null}
                            {tool.readOnlyHint !== true && tool.destructiveHint !== true ? (
                              <span className="muted small">keine Angabe</span>
                            ) : null}
                          </div>
                        </td>
                        <td className="cell-actions">
                          {action ? (
                            <div className="row">
                              <Link href={actionHref(action.id)}>Importiert</Link>
                              <McpDriftBadge drift={action.mcp_drift} />
                            </div>
                          ) : convertible.ok ? (
                            <form action={importMcpTool}>
                              <input type="hidden" name="org" value={orgId} />
                              <input type="hidden" name="connectionId" value={connectionId} />
                              <input type="hidden" name="tool" value={tool.name} />
                              <Button type="submit" size="sm" icon="plus">
                                Importieren
                              </Button>
                            </form>
                          ) : (
                            <span className="muted small">
                              Nicht importierbar: {MCP_IMPORT_ISSUE_LABELS[convertible.issue]}
                              {convertible.path ? ` (${convertible.path})` : ''}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>
    </>
  );
}
