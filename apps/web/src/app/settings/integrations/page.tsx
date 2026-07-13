import Link from 'next/link';
import type { CSSProperties } from 'react';
import { z } from 'zod';
import { decryptSecret, syncRulesSchema } from '@zendori/core';
import type { Channel, SyncRules } from '@zendori/core';
import { listTicketPipelines } from '@zendori/integrations';
import { requireActiveOrg } from '@/lib/org';
import { listChannels } from '@/lib/inbox/queries';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { connectHubspot, disconnectHubspot, saveHubspotConfig } from './actions';

const fieldStyle: CSSProperties = {
  width: '100%',
  padding: '0.55rem 0.75rem',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: '0.95rem',
  background: 'var(--surface)',
};

const helpStyle: CSSProperties = {
  fontSize: '0.85rem',
  color: 'var(--text-muted)',
  marginBottom: '1rem',
};

const labelStyle: CSSProperties = { display: 'block', marginBottom: '1rem' };

const checkboxRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  fontWeight: 400,
  marginBottom: '0.4rem',
};

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
};

function readConfig(raw: unknown): HubspotConfigView {
  const config = (raw ?? {}) as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    token_encrypted: typeof config.token_encrypted === 'string' ? config.token_encrypted : null,
    pipeline_id: str(config.pipeline_id),
    default_stage_id: str(config.default_stage_id),
    resolved_stage_id: str(config.resolved_stage_id),
    ui_domain: str(config.ui_domain),
    portal_id: str(config.portal_id),
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
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, orgs } = await requireActiveOrg(org);
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
  const rulesParsed = syncRulesSchema.safeParse(integrationRow?.rules);
  const rules: SyncRules = rulesParsed.success ? rulesParsed.data : { mode: 'manual' };
  const selectedChannelIds = new Set(rules.mode === 'channels' ? rules.channel_ids : []);

  const channels: Channel[] = connected ? await listChannels(orgId) : [];
  const { pipelines, failed: pipelinesFailed } =
    connected && config.token_encrypted
      ? await loadPipelines(config.token_encrypted)
      : { pipelines: [], failed: false };

  return (
    <div className="shell">
      <header>
        <span className="brand">Zendori</span>
        <Link href={`/inbox?org=${orgId}`}>Zurück zur Inbox</Link>
      </header>

      {error ? (
        <p className="error" style={{ marginBottom: '1.5rem' }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" style={{ marginBottom: '1.5rem' }}>
          {notice}
        </p>
      ) : null}

      <div className="panel">
        <h2>HubSpot — {orgName}</h2>
        <p style={helpStyle}>
          Einseitiger Sync: Konversationen werden als HubSpot-Tickets angelegt und aktualisiert. Der
          Private-App-Token wird verschlüsselt gespeichert und nie im Klartext angezeigt.
        </p>
        <p style={{ marginBottom: 0 }}>
          Status:{' '}
          {connected ? (
            <span className="inbox-badge inbox-badge-resolved">
              Verbunden{isActive ? '' : ' (inaktiv)'}
            </span>
          ) : (
            <span className="inbox-badge inbox-badge-neutral">Nicht verbunden</span>
          )}
        </p>
        {connected && config.portal_id ? (
          <p style={{ ...helpStyle, marginTop: '0.75rem', marginBottom: 0 }}>
            Portal-ID: {config.portal_id}
            {config.ui_domain ? ` · ${config.ui_domain}` : ''}
          </p>
        ) : null}
      </div>

      {!connected ? (
        <div className="panel">
          <h2>Verbinden</h2>
          <p style={helpStyle}>
            Private-App-Token der HubSpot-App des Kunden. Benötigte Scopes: „tickets",
            „crm.objects.contacts.read", „crm.objects.contacts.write". Der Token wird zunächst
            getestet (Account-Info + Pipelines) und dann verschlüsselt abgelegt.
          </p>
          <form action={connectHubspot}>
            <input type="hidden" name="org" value={orgId} />
            <label style={labelStyle}>
              Private-App-Token
              <input
                name="token"
                type="password"
                required
                autoComplete="off"
                placeholder="pat-eu1-…"
                style={fieldStyle}
              />
            </label>
            <button className="primary" type="submit">
              HubSpot verbinden
            </button>
          </form>
        </div>
      ) : (
        <>
          <div className="panel">
            <h2>Pipeline &amp; Stages</h2>
            {pipelinesFailed ? (
              <p className="error" style={{ marginBottom: '1rem' }}>
                Die Pipelines konnten nicht von HubSpot geladen werden (Token, Scopes oder
                Verbindung prüfen). Die zuletzt gespeicherten Werte bleiben erhalten.
              </p>
            ) : (
              <p style={helpStyle}>
                Neue Tickets landen in dieser Pipeline und Stage. Bitte eine Stage wählen, die zur
                gewählten Pipeline gehört. Die „Gelöst"-Stage ist optional — sie wird gesetzt, wenn
                eine Konversation auf „Gelöst" gestellt wird.
              </p>
            )}

            <form action={saveHubspotConfig}>
              <input type="hidden" name="org" value={orgId} />

              <label style={labelStyle}>
                Pipeline
                <select
                  name="pipeline_id"
                  defaultValue={config.pipeline_id}
                  style={fieldStyle}
                  aria-label="Pipeline"
                >
                  {pipelines.length === 0 ? (
                    <option value={config.pipeline_id}>{config.pipeline_id || '—'}</option>
                  ) : null}
                  {pipelines.map((pipeline) => (
                    <option key={pipeline.id} value={pipeline.id}>
                      {pipeline.label ?? pipeline.id}
                    </option>
                  ))}
                </select>
              </label>

              <label style={labelStyle}>
                Standard-Stage (neue Tickets)
                <select
                  name="default_stage_id"
                  defaultValue={config.default_stage_id}
                  style={fieldStyle}
                  aria-label="Standard-Stage"
                >
                  {pipelines.length === 0 ? (
                    <option value={config.default_stage_id}>
                      {config.default_stage_id || '—'}
                    </option>
                  ) : null}
                  {pipelines.map((pipeline) => (
                    <optgroup key={pipeline.id} label={pipeline.label ?? pipeline.id}>
                      {pipeline.stages.map((stage) => (
                        <option key={stage.id} value={stage.id}>
                          {stage.label ?? stage.id}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>

              <label style={labelStyle}>
                „Gelöst"-Stage (optional)
                <select
                  name="resolved_stage_id"
                  defaultValue={config.resolved_stage_id}
                  style={fieldStyle}
                  aria-label="Gelöst-Stage"
                >
                  <option value="">— kein Stage-Wechsel bei „Gelöst" —</option>
                  {pipelines.map((pipeline) => (
                    <optgroup key={pipeline.id} label={pipeline.label ?? pipeline.id}>
                      {pipeline.stages.map((stage) => (
                        <option key={stage.id} value={stage.id}>
                          {stage.label ?? stage.id}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>

              <h2 style={{ marginTop: '1.5rem' }}>Sync-Regeln</h2>
              <p style={helpStyle}>
                Legt fest, welche Konversationen automatisch an HubSpot gehen. Der Button „An
                HubSpot senden" pro Konversation funktioniert immer, unabhängig von dieser Regel.
              </p>
              <label style={labelStyle}>
                Regel
                <select
                  name="rules_mode"
                  defaultValue={rules.mode}
                  style={fieldStyle}
                  aria-label="Sync-Regel"
                >
                  <option value="all">Alle Konversationen</option>
                  <option value="channels">Nur ausgewählte Kanäle</option>
                  <option value="manual">Nur manuell</option>
                </select>
              </label>

              <fieldset style={{ border: 'none', padding: 0, margin: '0 0 1rem' }}>
                <legend style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                  Kanäle (nur wirksam bei Regel „Nur ausgewählte Kanäle")
                </legend>
                {channels.length === 0 ? (
                  <p className="inbox-sidebar-empty">Keine Kanäle vorhanden.</p>
                ) : (
                  channels.map((channel) => (
                    <label key={channel.id} style={checkboxRowStyle}>
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

              <label style={{ ...checkboxRowStyle, marginBottom: '1.25rem' }}>
                <input type="checkbox" name="is_active" defaultChecked={isActive} />
                Integration aktiv
              </label>

              <button className="primary" type="submit">
                Einstellungen speichern
              </button>
            </form>
          </div>

          <div className="panel">
            <h2>Verbindung trennen</h2>
            <p style={helpStyle}>
              Entfernt die Integration samt verschlüsseltem Token. Bereits erstellte HubSpot-Tickets
              bleiben in HubSpot bestehen.
            </p>
            <form action={disconnectHubspot}>
              <input type="hidden" name="org" value={orgId} />
              <button className="ghost" type="submit">
                HubSpot trennen
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
