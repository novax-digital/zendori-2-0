import Link from 'next/link';
import { z } from 'zod';
import { decryptSecret, parseHubspotSyncRules } from '@zendori/core';
import type { Channel, SyncRules } from '@zendori/core';
import { listTicketPipelines } from '@zendori/integrations';
import { requireActiveOrg } from '@/lib/org';
import { listChannels } from '@/lib/inbox/queries';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { connectHubspot, disconnectHubspot, saveHubspotConfig } from './actions';
import { createApiConnection } from './api/actions';
import { isAdminRole, isMissingRelationError } from '@zendori/core';
import { href } from '@/lib/href';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import SettingsFrame from '@/components/SettingsTabs';
import ApiAuthFields from '@/components/api-integration/ApiAuthFields';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field, SettingRow } from '@/components/ui/Field';
import { EmptyState, Section } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';

const PATH = '/settings/integrations';

// listTicketPipelines returns network data → parsed defensively (labels tolerate
// absence so a client-shape drift never crashes the settings page).
const pipelineListSchema = z.array(
  z
    .object({
      id: z.union([z.number(), z.string()]).transform(String),
      label: z.string().optional(),
      stages: z
        .array(
          z
            .object({
              id: z.union([z.number(), z.string()]).transform(String),
              label: z.string().optional(),
            })
            .passthrough()
        )
        .default([]),
    })
    .passthrough()
);

type HubspotPipeline = z.infer<typeof pipelineListSchema>[number];

type HubspotConfigView = {
  token_encrypted: string | null;
  pipeline_id: string;
  default_stage_id: string;
  resolved_stage_id: string;
  ui_domain: string;
  portal_id: string;
  /** Ticket stream (Phase 11b) — empty ids = not configured. */
  tickets: {
    pipeline_id: string;
    default_stage_id: string;
    resolved_stage_id: string;
    subject_prefix: boolean;
  };
};

function readConfig(raw: unknown): HubspotConfigView {
  const config = (raw ?? {}) as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const tickets = (config.tickets ?? {}) as Record<string, unknown>;
  return {
    token_encrypted: typeof config.token_encrypted === 'string' ? config.token_encrypted : null,
    pipeline_id: str(config.pipeline_id),
    default_stage_id: str(config.default_stage_id),
    resolved_stage_id: str(config.resolved_stage_id),
    ui_domain: str(config.ui_domain),
    portal_id: str(config.portal_id),
    tickets: {
      pipeline_id: str(tickets.pipeline_id),
      default_stage_id: str(tickets.default_stage_id),
      resolved_stage_id: str(tickets.resolved_stage_id),
      subject_prefix: tickets.subject_prefix !== false,
    },
  };
}

/** Decrypts the stored token server-side (never exposed) and loads pipelines. */
async function loadPipelines(
  tokenEncrypted: string
): Promise<{ pipelines: HubspotPipeline[]; failed: boolean }> {
  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  if (!masterKey) return { pipelines: [], failed: true };
  try {
    const token = await decryptSecret(tokenEncrypted, masterKey);
    const raw = await listTicketPipelines({ token });
    const parsed = pipelineListSchema.safeParse(raw);
    return { pipelines: parsed.success ? parsed.data : [], failed: !parsed.success };
  } catch {
    return { pipelines: [], failed: true };
  }
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string; panel?: string }>;
}) {
  const { org, error, notice, panel } = await searchParams;
  const { orgId, orgs, role, access } = await requireActiveOrg(org);
  if (!isAdminRole(role)) return <NoAccessPanel title="Integrationen" />;
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';

  const supabase = await createSupabaseServerClient();
  const { data: integrationRow } = await supabase
    .from('integrations')
    .select('config, rules, is_active')
    .eq('org_id', orgId)
    .eq('type', 'hubspot')
    .maybeSingle();

  const connected = Boolean(integrationRow);
  const config = readConfig(integrationRow?.config);
  const isActive = integrationRow?.is_active === true;
  const streams = parseHubspotSyncRules(integrationRow?.rules);
  const rules: SyncRules = streams.conversations;
  const selectedChannelIds = new Set(rules.mode === 'channels' ? rules.channel_ids : []);
  const ticketRules: SyncRules = streams.tickets;
  const ticketChannelIds = new Set(ticketRules.mode === 'channels' ? ticketRules.channel_ids : []);

  // Phase 13: the org's own end systems. Before migration 0035 the table is
  // missing — the section then explains itself instead of failing the page.
  const apiRes = await supabase
    .from('api_connections')
    .select('id, name, base_url, is_active')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  const apiAvailable = !apiRes.error || !isMissingRelationError(apiRes.error);
  const apiConnections = (apiRes.data ?? []) as {
    id: string;
    name: string;
    base_url: string;
    is_active: boolean;
  }[];
  const actionCounts = new Map<string, number>();
  if (apiConnections.length > 0) {
    const { data: actionRows } = await supabase
      .from('data_actions')
      .select('connection_id')
      .eq('org_id', orgId);
    for (const row of (actionRows ?? []) as { connection_id: string }[]) {
      actionCounts.set(row.connection_id, (actionCounts.get(row.connection_id) ?? 0) + 1);
    }
  }
  const apiNewHref = href(PATH, { org: orgId, panel: 'api-new' });
  const apiDrawerOpen = panel === 'api-new' && apiAvailable;

  const channels: Channel[] = connected ? await listChannels(orgId) : [];
  const { pipelines, failed: pipelinesFailed } =
    connected && config.token_encrypted
      ? await loadPipelines(config.token_encrypted)
      : { pipelines: [], failed: false };

  const listHref = href(PATH, { org: orgId });
  const connectHref = href(PATH, { org: orgId, panel: 'connect' });
  // the token form lives in a drawer; once connected there is nothing to connect
  const drawerOpen = panel === 'connect' && !connected;

  // one <optgroup> per pipeline, shared by the four stage selects
  const stageOptions = pipelines.map((pipeline) => (
    <optgroup key={pipeline.id} label={pipeline.label ?? pipeline.id}>
      {pipeline.stages.map((stage) => (
        <option key={stage.id} value={stage.id}>
          {stage.label ?? stage.id}
        </option>
      ))}
    </optgroup>
  ));

  return (
    <SettingsFrame access={access} orgId={orgId}>
      <div className="page">
        <PageHeader
          title="Integrationen"
          subtitle={`Verbinde ${orgName} mit externen Systemen.`}
        />

        <div className="page-body">
          {/* while the drawer is open its own banner shows the message */}
          {drawerOpen || apiDrawerOpen ? null : <DismissibleBanners error={error} notice={notice} />}

          <Section
            title="Verfügbare Integrationen"
            help={
              connected
                ? 'Trennen entfernt die Integration samt verschlüsseltem Token; bereits erstellte HubSpot-Tickets bleiben in HubSpot bestehen.'
                : undefined
            }
          >
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Integration</th>
                    <th>Status</th>
                    <th aria-label="Aktionen" />
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <div className="cell-title">HubSpot</div>
                      <div className="cell-sub">
                        Einseitiger Sync: Konversationen und Tickets werden als HubSpot-Tickets
                        angelegt und aktualisiert.
                        {connected && config.portal_id
                          ? ` Portal-ID ${config.portal_id}${config.ui_domain ? ` · ${config.ui_domain}` : ''}`
                          : ''}
                      </div>
                    </td>
                    <td>
                      {connected ? (
                        isActive ? (
                          <Badge tone="success" dot>
                            Aktiv
                          </Badge>
                        ) : (
                          <Badge tone="warn" dot>
                            Verbunden, inaktiv
                          </Badge>
                        )
                      ) : (
                        <Badge tone="muted" dot>
                          Nicht verbunden
                        </Badge>
                      )}
                    </td>
                    <td className="cell-actions">
                      {connected ? (
                        <Menu label="Aktionen für HubSpot">
                          <form action={disconnectHubspot}>
                            <input type="hidden" name="org" value={orgId} />
                            <button className="menu-item menu-item--danger" type="submit">
                              <span className="menu-label">HubSpot trennen</span>
                            </button>
                          </form>
                        </Menu>
                      ) : (
                        <Button href={connectHref} variant="primary" size="sm" scroll={false}>
                          Verbinden
                        </Button>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title="Eigene Endsysteme (API)"
            help="Verbinde eigene Systeme wie Shop, ERP oder Terminbuchung. KI-Agenten rufen sie über Aktionen auf, Zendori meldet Ereignisse dorthin und dein System kann Änderungen zurückmelden."
            actions={
              apiAvailable ? (
                <Button href={apiNewHref} size="sm" icon="plus" scroll={false}>
                  Neue Verbindung
                </Button>
              ) : null
            }
          >
            {!apiAvailable ? (
              <Callout>
                Diese Funktion ist noch nicht freigeschaltet (Datenbank-Migration 0035 steht aus).
              </Callout>
            ) : apiConnections.length === 0 ? (
              <EmptyState
                title="Noch keine Verbindung"
                text="Lege die erste Verbindung zu einem eigenen System an."
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Verbindung</th>
                      <th>Aktionen</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apiConnections.map((connection) => (
                      <tr key={connection.id}>
                        <td>
                          <div className="cell-title">
                            <Link href={href(`${PATH}/api/${connection.id}`, { org: orgId })}>
                              {connection.name}
                            </Link>
                          </div>
                          <div className="cell-sub mono">{connection.base_url}</div>
                        </td>
                        <td>{actionCounts.get(connection.id) ?? 0}</td>
                        <td>
                          {connection.is_active ? (
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

          {connected ? (
            <form
              id="hubspot-config-form"
              className="section-group form-narrow"
              action={saveHubspotConfig}
            >
              <input type="hidden" name="org" value={orgId} />

              <Section
                title="Pipeline und Stages"
                help="Neue Tickets landen in dieser Pipeline und Stage. Die Stage muss zur gewählten Pipeline gehören; die „Gelöst“-Stage ist optional und wird gesetzt, wenn eine Konversation auf „Gelöst“ gestellt wird."
              >
                {pipelinesFailed ? (
                  <Callout tone="danger">
                    Die Pipelines konnten nicht von HubSpot geladen werden (Token, Scopes oder
                    Verbindung prüfen). Die zuletzt gespeicherten Werte bleiben erhalten.
                  </Callout>
                ) : null}
                <Field label="Pipeline" htmlFor="hs-pipeline">
                  <select id="hs-pipeline" name="pipeline_id" defaultValue={config.pipeline_id}>
                    {pipelines.length === 0 ? (
                      <option value={config.pipeline_id}>{config.pipeline_id || '—'}</option>
                    ) : null}
                    {pipelines.map((pipeline) => (
                      <option key={pipeline.id} value={pipeline.id}>
                        {pipeline.label ?? pipeline.id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Standard-Stage (neue Tickets)" htmlFor="hs-stage">
                  <select id="hs-stage" name="default_stage_id" defaultValue={config.default_stage_id}>
                    {pipelines.length === 0 ? (
                      <option value={config.default_stage_id}>
                        {config.default_stage_id || '—'}
                      </option>
                    ) : null}
                    {stageOptions}
                  </select>
                </Field>
                <Field label="„Gelöst“-Stage (optional)" htmlFor="hs-resolved">
                  <select
                    id="hs-resolved"
                    name="resolved_stage_id"
                    defaultValue={config.resolved_stage_id}
                  >
                    <option value="">— kein Stage-Wechsel bei „Gelöst“ —</option>
                    {stageOptions}
                  </select>
                </Field>
              </Section>

              <Section
                title="Konversationen an HubSpot"
                help="Welche Konversationen automatisch an HubSpot gehen (Pipeline und Stages oben). „An HubSpot senden“ an einer Konversation funktioniert immer, unabhängig von dieser Regel."
              >
                <Field label="Regel" htmlFor="hs-rule">
                  <select id="hs-rule" name="rules_mode" defaultValue={rules.mode}>
                    <option value="all">Alle Konversationen</option>
                    <option value="channels">Nur ausgewählte Kanäle</option>
                    <option value="manual">Nur manuell</option>
                  </select>
                </Field>
                <fieldset className="check-list">
                  <legend>Kanäle (nur wirksam bei Regel „Nur ausgewählte Kanäle“)</legend>
                  {channels.length === 0 ? (
                    <p className="muted small">Keine Kanäle vorhanden.</p>
                  ) : (
                    channels.map((channel) => (
                      <label key={channel.id} className="check-row">
                        <input
                          type="checkbox"
                          name="channel_ids"
                          value={channel.id}
                          defaultChecked={selectedChannelIds.has(channel.id)}
                        />
                        {channel.name}
                      </label>
                    ))
                  )}
                </fieldset>
              </Section>

              <Section
                title="Tickets an HubSpot"
                help="Eigener Strom für Zendori-Tickets mit eigener Pipeline und Regel; beide Ströme können parallel laufen. Ohne Ticket-Pipeline werden Tickets nicht übertragen."
              >
                <Field label="Ticket-Pipeline" htmlFor="hs-ticket-pipeline">
                  <select
                    id="hs-ticket-pipeline"
                    name="ticket_pipeline_id"
                    defaultValue={config.tickets.pipeline_id}
                  >
                    <option value="">— nicht konfiguriert —</option>
                    {pipelines.length === 0 && config.tickets.pipeline_id ? (
                      <option value={config.tickets.pipeline_id}>{config.tickets.pipeline_id}</option>
                    ) : null}
                    {pipelines.map((pipeline) => (
                      <option key={pipeline.id} value={pipeline.id}>
                        {pipeline.label ?? pipeline.id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Standard-Stage (neue Tickets)" htmlFor="hs-ticket-stage">
                  <select
                    id="hs-ticket-stage"
                    name="ticket_default_stage_id"
                    defaultValue={config.tickets.default_stage_id}
                  >
                    <option value="">—</option>
                    {stageOptions}
                  </select>
                </Field>
                <Field label="„Erledigt“-Stage (optional)" htmlFor="hs-ticket-resolved">
                  <select
                    id="hs-ticket-resolved"
                    name="ticket_resolved_stage_id"
                    defaultValue={config.tickets.resolved_stage_id}
                  >
                    <option value="">— kein Stage-Wechsel bei „Erledigt“ —</option>
                    {stageOptions}
                  </select>
                </Field>
                <SettingRow
                  label="Ticket-ID im HubSpot-Betreff voranstellen"
                  help="Zum Beispiel „[ZD-2026-0042] Rechnungsfrage“."
                  htmlFor="hs-ticket-prefix"
                >
                  <input
                    id="hs-ticket-prefix"
                    type="checkbox"
                    className="switch"
                    name="ticket_subject_prefix"
                    defaultChecked={config.tickets.subject_prefix}
                  />
                </SettingRow>
                <Field label="Regel" htmlFor="hs-ticket-rule">
                  <select id="hs-ticket-rule" name="ticket_rules_mode" defaultValue={ticketRules.mode}>
                    <option value="all">Alle Tickets</option>
                    <option value="channels">Nur Tickets ausgewählter Kanäle</option>
                    <option value="manual">Nur manuell</option>
                  </select>
                </Field>
                <fieldset className="check-list">
                  <legend>Kanäle (nur wirksam bei Regel „Nur Tickets ausgewählter Kanäle“)</legend>
                  {channels.length === 0 ? (
                    <p className="muted small">Keine Kanäle vorhanden.</p>
                  ) : (
                    channels.map((channel) => (
                      <label key={channel.id} className="check-row">
                        <input
                          type="checkbox"
                          name="ticket_channel_ids"
                          value={channel.id}
                          defaultChecked={ticketChannelIds.has(channel.id)}
                        />
                        {channel.name}
                      </label>
                    ))
                  )}
                </fieldset>
              </Section>

              <Section title="Status">
                <SettingRow
                  label="Integration aktiv"
                  help="Ausgeschaltet bleibt die Verbindung bestehen, es wird aber nichts übertragen."
                  htmlFor="hs-active"
                >
                  <input
                    id="hs-active"
                    type="checkbox"
                    className="switch"
                    name="is_active"
                    defaultChecked={isActive}
                  />
                </SettingRow>
              </Section>
            </form>
          ) : null}
        </div>

        {connected ? (
          <div className="save-bar">
            <Button type="submit" form="hubspot-config-form" variant="primary">
              Einstellungen speichern
            </Button>
          </div>
        ) : null}

        {drawerOpen ? (
          <Drawer
            title="HubSpot verbinden"
            closeHref={listHref}
            footer={
              <>
                <Button href={listHref} scroll={false}>
                  Abbrechen
                </Button>
                <Button type="submit" form="hubspot-connect-form" variant="primary">
                  HubSpot verbinden
                </Button>
              </>
            }
          >
            <DismissibleBanners error={error} notice={notice} />
            <form id="hubspot-connect-form" className="stack" action={connectHubspot}>
              <input type="hidden" name="org" value={orgId} />
              <Field
                label="Private-App-Token"
                htmlFor="hs-token"
                help="Token der HubSpot-App des Kunden mit den Scopes „tickets“, „crm.objects.contacts.read“ und „crm.objects.contacts.write“. Er wird zuerst getestet (Account-Info und Pipelines), dann verschlüsselt gespeichert und nie im Klartext angezeigt."
              >
                <input
                  id="hs-token"
                  name="token"
                  type="password"
                  required
                  autoComplete="off"
                  placeholder="pat-eu1-…"
                />
              </Field>
            </form>
          </Drawer>
        ) : null}

        {apiDrawerOpen ? (
          <Drawer
            title="Neue Verbindung"
            closeHref={listHref}
            footer={
              <>
                <Button href={listHref} scroll={false}>
                  Abbrechen
                </Button>
                <Button type="submit" form="api-connection-form" variant="primary">
                  Verbindung anlegen
                </Button>
              </>
            }
          >
            <DismissibleBanners error={error} notice={notice} />
            <form id="api-connection-form" className="stack" action={createApiConnection}>
              <input type="hidden" name="org" value={orgId} />
              <Field label="Name" htmlFor="api-new-name" help="So heißt das System in Zendori.">
                <input
                  id="api-new-name"
                  name="name"
                  type="text"
                  required
                  minLength={2}
                  maxLength={80}
                  placeholder="z. B. Shop-System"
                />
              </Field>
              <Field
                label="Basis-URL"
                htmlFor="api-new-url"
                help="Adresse der API ohne einzelne Endpunkte, nur https. Die Pfade legst du pro Aktion fest."
              >
                <input
                  id="api-new-url"
                  name="baseUrl"
                  type="url"
                  required
                  maxLength={500}
                  placeholder="https://api.example.com/v1"
                />
              </Field>
              <ApiAuthFields idPrefix="api-new" />
            </form>
          </Drawer>
        ) : null}
      </div>
    </SettingsFrame>
  );
}
