// Phase 13 — one API connection (an org's own end system): connection data and
// credentials, its data actions, outbound events, API keys and the run log.
// Owner/admin only. Tabs live in the URL (?tab=), every form is a plain
// server-action form. The events and keys tabs tolerate the schema before
// migrations 0036 / 0037 (they then explain that the feature is not live yet).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  INTEGRATION_EVENT_TYPES,
  apiConnectionConfigSchema,
  decryptSecret,
  isAdminRole,
} from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { href } from '@/lib/href';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { appUrl } from '@/lib/env';
import {
  EVENT_ERROR_LABELS,
  EVENT_STATE_LABELS,
  EVENT_STATE_TONES,
  EVENT_TYPE_LABELS,
  RUN_ERROR_LABELS,
  RUN_STATE_LABELS,
  RUN_STATE_TONES,
  RUN_TRIGGER_LABELS,
  formatDateTime,
} from '@/lib/api-integration/labels';
import ApiAuthFields from '@/components/api-integration/ApiAuthFields';
import ApiKeyCreator from '@/components/api-integration/ApiKeyCreator';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { Field, SettingRow } from '@/components/ui/Field';
import { EmptyState, Section, Tabs } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import {
  deleteApiConnection,
  revokeApiKey,
  rotateSigningSecret,
  saveEventSettings,
  sendTestEvent,
  updateApiConnection,
} from '../actions';

const LIST_PATH = '/settings/integrations';

type TabKey = 'connection' | 'actions' | 'events' | 'keys' | 'runs';
const TAB_KEYS: readonly TabKey[] = ['connection', 'actions', 'events', 'keys', 'runs'];

/** The public API at a glance (handlers: packages/core/src/public-api.ts). */
const API_ENDPOINTS: { call: string; effect: string }[] = [
  { call: 'GET /me', effect: 'Schlüssel prüfen: liefert Organisation und Verbindung.' },
  { call: 'GET /tickets/{ref}', effect: 'Ticket mit Kontakt lesen (ohne Nachrichtentexte).' },
  {
    call: 'PATCH /tickets/{ref}',
    effect: 'status, priority oder category ändern, z. B. {"status":"resolved"}.',
  },
  {
    call: 'POST /tickets/{ref}/notes',
    effect: 'Interne Notiz anhängen: {"content":"…"}. Mit Header Idempotency-Key wiederholbar.',
  },
  {
    call: 'GET /conversations/{ref}',
    effect: 'Status, Kanal und Kontakt einer Konversation lesen.',
  },
  {
    call: 'POST /conversations/{ref}/notes',
    effect: 'Interne Notiz an die Konversation anhängen.',
  },
  { call: 'GET /contacts/{ref}', effect: 'Kontakt lesen.' },
  { call: 'PATCH /contacts/{ref}', effect: 'name, email, phone oder company korrigieren.' },
  {
    call: 'PUT /links',
    effect: 'Eigene ID verknüpfen: {"entity_type":"ticket","entity_id":"…","external_id":"…"}.',
  },
];

/** Example body of one event delivery, shown to the integrator. */
const EVENT_EXAMPLE = `{
  "id": "5d0c…",                 // gleich dem Header webhook-id
  "type": "ticket.updated",
  "created_at": "2026-11-20T10:00:00Z",
  "org_id": "…",
  "changes": { "changed": ["status"], "status_from": "open", "status_to": "resolved" },
  "data": {
    "ticket": {
      "id": "…", "display_id": "ZD-2026-0042", "status": "resolved", "priority": "normal",
      "subject": "…", "description": "…", "category": "…", "conversation_id": "…",
      "external_id": "ERP-9001",
      "contact": { "id": "…", "name": "…", "email": "…", "phone": "…", "company": "…" }
    }
  }
}`;

interface EventLogRow {
  id: string;
  event_type: string;
  state: string;
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface ActionListRow {
  id: string;
  name: string;
  label: string;
  kind: string;
  method: string;
  path: string;
  requires_confirmation: boolean;
  is_active: boolean;
}

interface RunListRow {
  id: string;
  data_action_id: string;
  trigger: string;
  state: string;
  http_status: number | null;
  latency_ms: number | null;
  error_code: string | null;
  created_at: string;
}

export default async function ApiConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ connectionId: string }>;
  searchParams: Promise<{
    org?: string;
    tab?: string;
    reveal?: string;
    error?: string;
    notice?: string;
  }>;
}) {
  const { connectionId } = await params;
  const { org, tab: rawTab, reveal, error, notice } = await searchParams;
  const { orgId, role } = await requireActiveOrg(org);
  if (!isAdminRole(role)) return <NoAccessPanel title="Integrationen" />;

  const supabase = await createSupabaseServerClient();
  const { data: connectionRow } = await supabase
    .from('api_connections')
    .select('id, name, base_url, config, is_active')
    .eq('org_id', orgId)
    .eq('id', connectionId)
    .maybeSingle();
  if (!connectionRow) notFound();
  const connection = connectionRow as {
    id: string;
    name: string;
    base_url: string;
    config: unknown;
    is_active: boolean;
  };
  const configParsed = apiConnectionConfigSchema.safeParse(connection.config ?? {});
  const config = configParsed.success ? configParsed.data : { auth: { kind: 'none' as const } };
  const auth = config.auth;

  const tab: TabKey = TAB_KEYS.find((key) => key === rawTab) ?? 'connection';
  const selfPath = `${LIST_PATH}/api/${connection.id}`;
  const tabHref = (key: TabKey): string =>
    href(selfPath, { org: orgId, tab: key === 'connection' ? null : key });

  const { data: actionData } = await supabase
    .from('data_actions')
    .select('id, name, label, kind, method, path, requires_confirmation, is_active')
    .eq('org_id', orgId)
    .eq('connection_id', connection.id)
    .order('created_at', { ascending: true });
  const actions = (actionData ?? []) as ActionListRow[];
  const actionLabels = new Map(actions.map((a) => [a.id, a.label]));

  let runs: RunListRow[] = [];
  if (tab === 'runs' && actions.length > 0) {
    const { data: runData } = await supabase
      .from('action_runs')
      .select('id, data_action_id, trigger, state, http_status, latency_ms, error_code, created_at')
      .eq('org_id', orgId)
      .in(
        'data_action_id',
        actions.map((a) => a.id)
      )
      .order('created_at', { ascending: false })
      .limit(50);
    runs = (runData ?? []) as RunListRow[];
  }

  // Outbound events (0036). The columns are read separately so the page still
  // works before the migration: an error then means "not available yet".
  let eventsAvailable = false;
  let eventUrl = '';
  let eventTypes = new Set<string>();
  let eventLog: EventLogRow[] = [];
  if (tab === 'events') {
    const { data: eventRow, error: eventError } = await supabase
      .from('api_connections')
      .select('event_url, event_types')
      .eq('org_id', orgId)
      .eq('id', connection.id)
      .maybeSingle();
    if (!eventError && eventRow) {
      eventsAvailable = true;
      const row = eventRow as { event_url: string | null; event_types: string[] | null };
      eventUrl = row.event_url ?? '';
      eventTypes = new Set(row.event_types ?? []);
      const { data: logData } = await supabase
        .from('integration_events')
        .select('id, event_type, state, attempts, last_status, last_error, created_at, sent_at')
        .eq('org_id', orgId)
        .eq('connection_id', connection.id)
        .order('created_at', { ascending: false })
        .limit(30);
      eventLog = (logData ?? []) as EventLogRow[];
    }
  }

  // API keys (0037) — same pre-migration tolerance.
  let keysAvailable = false;
  let apiKeys: ApiKeyRow[] = [];
  if (tab === 'keys') {
    const { data: keyData, error: keyError } = await supabase
      .from('api_keys')
      .select('id, name, key_prefix, last_used_at, revoked_at, created_at')
      .eq('org_id', orgId)
      .eq('connection_id', connection.id)
      .order('created_at', { ascending: false });
    if (!keyError) {
      keysAvailable = true;
      apiKeys = (keyData ?? []) as ApiKeyRow[];
    }
  }
  const apiBase = `${appUrl().replace(/\/+$/, '')}/api/v1`;

  // The signing secret is the one value an owner may look at again: the end
  // system needs it to verify Zendori's requests. Decrypted only on request.
  let signingSecret: string | null = null;
  if (tab === 'connection' && reveal === 'signing' && config.signing_secret_encrypted) {
    const masterKey = process.env.MASTER_ENCRYPTION_KEY;
    if (masterKey) {
      try {
        signingSecret = await decryptSecret(config.signing_secret_encrypted, masterKey);
      } catch {
        signingSecret = null;
      }
    }
  }

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[
          { label: 'Integrationen', href: href(LIST_PATH, { org: orgId }) },
          { label: connection.name },
        ]}
        title={connection.name}
        subtitle={<span className="mono">{connection.base_url}</span>}
        badges={
          connection.is_active ? (
            <Badge tone="success" dot>
              Aktiv
            </Badge>
          ) : (
            <Badge tone="muted" dot>
              Pausiert
            </Badge>
          )
        }
        actions={
          <Menu label="Weitere Aktionen">
            <form action={deleteApiConnection}>
              <input type="hidden" name="org" value={orgId} />
              <input type="hidden" name="connectionId" value={connection.id} />
              <ConfirmDeleteButton
                inMenu
                label="Verbindung löschen"
                confirmLabel="Endgültig löschen"
              />
            </form>
            <p className="menu-note">
              Löscht auch alle Aktionen und das Protokoll dieser Verbindung.
            </p>
          </Menu>
        }
        tabs={
          <Tabs
            label="Bereiche der Verbindung"
            items={[
              { label: 'Verbindung', href: tabHref('connection'), active: tab === 'connection' },
              {
                label: 'Aktionen',
                href: tabHref('actions'),
                count: actions.length,
                active: tab === 'actions',
              },
              { label: 'Ereignisse', href: tabHref('events'), active: tab === 'events' },
              { label: 'API-Schlüssel', href: tabHref('keys'), active: tab === 'keys' },
              { label: 'Protokoll', href: tabHref('runs'), active: tab === 'runs' },
            ]}
          />
        }
      />

      <div className="page-body">
        <DismissibleBanners error={error} notice={notice} />

        {tab === 'connection' ? (
          <>
            <form
              id="api-connection-form"
              className="section-group form-narrow"
              action={updateApiConnection}
            >
              <input type="hidden" name="org" value={orgId} />
              <input type="hidden" name="connectionId" value={connection.id} />
              <Section title="Endsystem">
                <Field label="Name" htmlFor="api-name">
                  <input
                    id="api-name"
                    name="name"
                    type="text"
                    required
                    minLength={2}
                    maxLength={80}
                    defaultValue={connection.name}
                  />
                </Field>
                <Field
                  label="Basis-URL"
                  htmlFor="api-url"
                  help="Nur https und nur öffentlich erreichbare Adressen. Alle Aufrufe kommen vom Zendori-Worker, also von einer festen IP-Adresse, die du in deinem System freischalten kannst."
                >
                  <input
                    id="api-url"
                    name="baseUrl"
                    type="url"
                    required
                    maxLength={500}
                    defaultValue={connection.base_url}
                  />
                </Field>
                <ApiAuthFields
                  idPrefix="api"
                  defaultKind={auth.kind}
                  defaultHeaderName={auth.kind === 'header' ? auth.header_name : ''}
                  defaultUsername={auth.kind === 'basic' ? auth.username : ''}
                  hasStoredSecret={auth.kind !== 'none'}
                />
              </Section>
              <Section title="Status">
                <SettingRow
                  label="Verbindung aktiv"
                  help="Pausiert stehen ihre Aktionen den Agenten nicht zur Verfügung."
                  htmlFor="api-active"
                >
                  <input
                    id="api-active"
                    type="checkbox"
                    className="switch"
                    name="isActive"
                    defaultChecked={connection.is_active}
                  />
                </SettingRow>
              </Section>
            </form>

            <div className="section-group form-narrow">
              <Section
                title="Signatur"
                help="Zendori signiert jeden Aufruf (Standard Webhooks, HMAC-SHA256) mit den Headern webhook-id, webhook-timestamp und webhook-signature. Dein System kann damit prüfen, dass ein Aufruf wirklich von Zendori stammt. Jeder Aufruf trägt außerdem einen Idempotency-Key."
              >
                {signingSecret ? (
                  <div className="stack stack--sm">
                    <span className="field-label">Signatur-Schlüssel</span>
                    <code className="code-block">{signingSecret}</code>
                    <div>
                      <Button href={tabHref('connection')} size="sm" scroll={false}>
                        Ausblenden
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="row">
                    {config.signing_secret_encrypted ? (
                      <Button
                        href={href(selfPath, { org: orgId, reveal: 'signing' })}
                        size="sm"
                        icon="eye"
                        scroll={false}
                      >
                        Schlüssel anzeigen
                      </Button>
                    ) : (
                      <span className="muted small">Noch kein Signatur-Schlüssel vorhanden.</span>
                    )}
                    <form action={rotateSigningSecret}>
                      <input type="hidden" name="org" value={orgId} />
                      <input type="hidden" name="connectionId" value={connection.id} />
                      <Button type="submit" size="sm">
                        Neuen Schlüssel erzeugen
                      </Button>
                    </form>
                  </div>
                )}
              </Section>
            </div>

            <div className="save-bar">
              <Button type="submit" form="api-connection-form" variant="primary">
                Verbindung speichern
              </Button>
            </div>
          </>
        ) : null}

        {tab === 'actions' ? (
          <Section
            title="Aktionen"
            help="Eine Aktion ist ein einzelner Aufruf deines Systems, den ein KI-Agent im Gespräch nutzen kann. Welcher Agent welche Aktion verwenden darf, legst du am Agenten fest."
            actions={
              <Button
                href={href(`${selfPath}/actions/new`, { org: orgId })}
                size="sm"
                icon="plus"
                variant="primary"
              >
                Neue Aktion
              </Button>
            }
          >
            {actions.length === 0 ? (
              <EmptyState
                title="Noch keine Aktion"
                text="Lege die erste Aktion an, z. B. „Bestellstatus abfragen“."
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Aktion</th>
                      <th>Aufruf</th>
                      <th>Art</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actions.map((action) => (
                      <tr key={action.id}>
                        <td>
                          <div className="cell-title">
                            <Link href={href(`${selfPath}/actions/${action.id}`, { org: orgId })}>
                              {action.label}
                            </Link>
                          </div>
                          <div className="cell-sub mono">{action.name}</div>
                        </td>
                        <td className="mono small">
                          {action.method} {action.path}
                        </td>
                        <td>
                          {action.kind === 'write' ? (
                            <Badge tone={action.requires_confirmation ? 'warn' : 'accent'}>
                              {action.requires_confirmation
                                ? 'Schreibt, mit Bestätigung'
                                : 'Schreibt'}
                            </Badge>
                          ) : (
                            <Badge>Liest</Badge>
                          )}
                        </td>
                        <td>
                          {action.is_active ? (
                            <Badge tone="success" dot>
                              Aktiv
                            </Badge>
                          ) : (
                            <Badge tone="muted" dot>
                              Pausiert
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        ) : null}

        {tab === 'events' ? (
          !eventsAvailable ? (
            <Callout>
              Ereignisse sind noch nicht freigeschaltet (Datenbank-Migration 0036 steht aus).
            </Callout>
          ) : (
            <>
              <form
                id="api-events-form"
                className="section-group form-narrow"
                action={saveEventSettings}
              >
                <input type="hidden" name="org" value={orgId} />
                <input type="hidden" name="connectionId" value={connection.id} />
                <Section
                  title="Ereignisse an dein System"
                  help="Zendori sendet bei jeder ausgewählten Änderung einen signierten POST mit JSON an diese Adresse — mit denselben Zugangsdaten und derselben Signatur wie die Aktionen. Nachrichtentexte werden nie mitgesendet."
                >
                  <Field
                    label="Ereignis-Adresse"
                    htmlFor="event-url"
                    help="Nur https. Leer lassen schaltet die Zustellung ab. Antworte mit einem 2xx-Status; sonst versucht Zendori es bis zu sechsmal über rund neun Stunden erneut."
                  >
                    <input
                      id="event-url"
                      name="eventUrl"
                      type="url"
                      maxLength={500}
                      defaultValue={eventUrl}
                      placeholder="https://erp.example.com/webhooks/zendori"
                    />
                  </Field>
                  <fieldset className="fieldset-plain">
                    <legend className="field-label">Welche Ereignisse?</legend>
                    {INTEGRATION_EVENT_TYPES.map((type) => (
                      <label key={type} className="check-row">
                        <input
                          type="checkbox"
                          name="eventTypes"
                          value={type}
                          defaultChecked={eventTypes.has(type)}
                        />
                        {EVENT_TYPE_LABELS[type]?.title ?? type}
                        <span className="muted small">
                          <span className="mono">{type}</span> · {EVENT_TYPE_LABELS[type]?.help}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <Callout>
                    Änderungen, die dein System selbst über die Zendori-API vornimmt, werden nicht
                    an dieses System zurückgemeldet. Jedes Ereignis trägt eine eindeutige ID (Header{' '}
                    <span className="mono">webhook-id</span>); bei einer Wiederholung bleibt sie
                    gleich.
                  </Callout>
                  <details className="disclosure">
                    <summary>Beispiel: So sieht ein Ereignis aus</summary>
                    <code className="code-block run-result">{EVENT_EXAMPLE}</code>
                  </details>
                </Section>
              </form>

              <div className="section-group">
                <Section
                  title="Zustellprotokoll"
                  help="Die letzten 30 Ereignisse dieser Verbindung. Zugestellte und aufgegebene Ereignisse werden nach 30 Tagen gelöscht."
                  actions={
                    eventUrl ? (
                      <form action={sendTestEvent}>
                        <input type="hidden" name="org" value={orgId} />
                        <input type="hidden" name="connectionId" value={connection.id} />
                        <Button type="submit" size="sm" icon="flask">
                          Test-Ereignis senden
                        </Button>
                      </form>
                    ) : null
                  }
                >
                  {eventLog.length === 0 ? (
                    <EmptyState
                      title="Noch keine Ereignisse"
                      text="Speichere eine Adresse und sende ein Test-Ereignis."
                    />
                  ) : (
                    <div className="table-wrap">
                      <table className="table--compact">
                        <thead>
                          <tr>
                            <th>Zeit</th>
                            <th>Ereignis</th>
                            <th>Zustellung</th>
                            <th>Versuche</th>
                            <th>HTTP</th>
                          </tr>
                        </thead>
                        <tbody>
                          {eventLog.map((event) => (
                            <tr key={event.id}>
                              <td className="nowrap">{formatDateTime(event.created_at)}</td>
                              <td>
                                {EVENT_TYPE_LABELS[event.event_type]?.title ?? event.event_type}
                                <div className="cell-sub mono">{event.event_type}</div>
                              </td>
                              <td>
                                <Badge tone={EVENT_STATE_TONES[event.state] ?? 'neutral'} dot>
                                  {EVENT_STATE_LABELS[event.state] ?? event.state}
                                </Badge>
                                {event.last_error ? (
                                  <div className="cell-sub">
                                    {EVENT_ERROR_LABELS[event.last_error] ?? event.last_error}
                                  </div>
                                ) : null}
                              </td>
                              <td>{event.attempts}</td>
                              <td>{event.last_status ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Section>
              </div>

              <div className="save-bar">
                <Button type="submit" form="api-events-form" variant="primary">
                  Ereignisse speichern
                </Button>
              </div>
            </>
          )
        ) : null}

        {tab === 'keys' ? (
          !keysAvailable ? (
            <Callout>
              Die Zendori-API ist noch nicht freigeschaltet (Datenbank-Migration 0037 steht aus).
            </Callout>
          ) : (
            <div className="section-group form-narrow">
              <Section
                title="Zendori-API für dein System"
                help="Mit einem Schlüssel kann dein System Tickets und Kontakte lesen, Ticket-Status, Priorität und Kategorie ändern, Kontaktdaten korrigieren, interne Notizen anhängen und eigene IDs verknüpfen. Konversationen oder Nachrichten kann es nicht anlegen."
              >
                <div className="stack stack--sm">
                  <span className="field-label">Basis-Adresse</span>
                  <code className="code-block">{apiBase}</code>
                  <span className="field-label">Schlüssel prüfen</span>
                  <code className="code-block">
                    {`curl -H "Authorization: Bearer <SCHLÜSSEL>" ${apiBase}/me`}
                  </code>
                </div>
                <div className="table-wrap">
                  <table className="table--compact">
                    <thead>
                      <tr>
                        <th>Aufruf</th>
                        <th>Wirkung</th>
                      </tr>
                    </thead>
                    <tbody>
                      {API_ENDPOINTS.map((endpoint) => (
                        <tr key={endpoint.call}>
                          <td className="mono small nowrap">{endpoint.call}</td>
                          <td className="small">{endpoint.effect}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="field-help">
                  <span className="mono">{'{ref}'}</span> ist die Zendori-ID oder{' '}
                  <span className="mono">ext:&lt;eure ID&gt;</span>, sobald ihr sie über{' '}
                  <span className="mono">PUT /links</span> verknüpft habt. Anfragen und Antworten
                  sind JSON; Fehler haben die Form{' '}
                  <span className="mono">{'{"error":{"code","message"}}'}</span>. Pro Schlüssel sind
                  120 Anfragen pro Minute erlaubt.
                </p>
              </Section>

              <Section
                title="Schlüssel"
                help="Jeder Schlüssel gehört zu dieser Verbindung. Lege pro Umgebung einen eigenen an, damit du ihn einzeln widerrufen kannst."
              >
                <ApiKeyCreator orgId={orgId} connectionId={connection.id} />
                {apiKeys.length === 0 ? (
                  <p className="muted small">Noch kein Schlüssel vorhanden.</p>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Schlüssel</th>
                          <th>Zuletzt verwendet</th>
                          <th>Status</th>
                          <th aria-label="Aktionen" />
                        </tr>
                      </thead>
                      <tbody>
                        {apiKeys.map((key) => (
                          <tr key={key.id}>
                            <td>
                              <div className="cell-title">{key.name}</div>
                              <div className="cell-sub mono">{key.key_prefix}…</div>
                            </td>
                            <td className="nowrap">{formatDateTime(key.last_used_at)}</td>
                            <td>
                              {key.revoked_at ? (
                                <Badge tone="muted" dot>
                                  Widerrufen
                                </Badge>
                              ) : (
                                <Badge tone="success" dot>
                                  Aktiv
                                </Badge>
                              )}
                            </td>
                            <td className="cell-actions">
                              {key.revoked_at ? null : (
                                <Menu label={`Aktionen für ${key.name}`}>
                                  <form action={revokeApiKey}>
                                    <input type="hidden" name="org" value={orgId} />
                                    <input
                                      type="hidden"
                                      name="connectionId"
                                      value={connection.id}
                                    />
                                    <input type="hidden" name="keyId" value={key.id} />
                                    <ConfirmDeleteButton
                                      inMenu
                                      label="Schlüssel widerrufen"
                                      confirmLabel="Endgültig widerrufen"
                                    />
                                  </form>
                                  <p className="menu-note">
                                    Ein widerrufener Schlüssel kann nicht wieder aktiviert werden.
                                  </p>
                                </Menu>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            </div>
          )
        ) : null}

        {tab === 'runs' ? (
          <Section
            title="Protokoll"
            help="Die letzten 50 Läufe aller Aktionen dieser Verbindung: Testläufe, Aufrufe der Agenten und bestätigte Aktionen."
          >
            {runs.length === 0 ? (
              <EmptyState title="Noch keine Läufe" text="Starte einen Testlauf an einer Aktion." />
            ) : (
              <div className="table-wrap">
                <table className="table--compact">
                  <thead>
                    <tr>
                      <th>Zeit</th>
                      <th>Aktion</th>
                      <th>Auslöser</th>
                      <th>Ergebnis</th>
                      <th>HTTP</th>
                      <th>Dauer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.id}>
                        <td className="nowrap">{formatDateTime(run.created_at)}</td>
                        <td>{actionLabels.get(run.data_action_id) ?? '—'}</td>
                        <td>{RUN_TRIGGER_LABELS[run.trigger] ?? run.trigger}</td>
                        <td>
                          <Badge
                            tone={RUN_STATE_TONES[run.state] ?? 'neutral'}
                            dot
                            title={run.error_code ? RUN_ERROR_LABELS[run.error_code] : undefined}
                          >
                            {RUN_STATE_LABELS[run.state] ?? run.state}
                          </Badge>
                          {run.error_code ? (
                            <div className="cell-sub">
                              {RUN_ERROR_LABELS[run.error_code] ?? run.error_code}
                            </div>
                          ) : null}
                        </td>
                        <td>{run.http_status ?? '—'}</td>
                        <td className="nowrap">
                          {run.latency_ms !== null ? `${run.latency_ms} ms` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Callout className="page-note">
              Das Protokoll enthält die gesendeten Werte und die freigegebenen Antwortfelder. Es
              wird zusammen mit der Organisation gelöscht.
            </Callout>
          </Section>
        ) : null}
      </div>
    </div>
  );
}
