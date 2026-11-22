'use server';

// Phase 13 — API-Integration: server actions for connections (an org's own end
// systems) and their data actions. Owner/admin only (RLS enforces it on every
// table; the explicit gate gives a readable message instead of a silent no-op).
// Secrets are encrypted before they touch the database and are never rendered,
// logged or returned — the only exception is the signing secret, which the
// owner may reveal on purpose (the end system needs it to verify requests).
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  MCP_ACTION_METHOD,
  MCP_ACTION_PATH,
  MCP_ACTION_TIMEOUT_DEFAULT_MS,
  apiBaseUrlSchema,
  apiConnectionConfigSchema,
  apiConnectionKindSchema,
  apiEventUrlSchema,
  integrationEventTypesSchema,
  checkDataActionDefinition,
  coerceActionValues,
  dataActionDefinitionSchema,
  dataActionParametersSchema,
  draftActionFromMcpTool,
  encryptSecret,
  generateApiKey,
  isMcpParameterList,
  isMissingColumnError,
  mcpCatalogSchema,
  mcpEndpointUrlSchema,
  mergeReimportedParameters,
  type ApiConnectionAuth,
  type ApiConnectionConfig,
  type ApiConnectionKind,
  type DataActionDefinitionIssue,
  type McpCatalogTool,
} from '@zendori/core';
import { generateSigningSecret } from '@zendori/integrations';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { MCP_IMPORT_ISSUE_LABELS } from '@/lib/api-integration/labels';
import { checkRateLimit } from '@/lib/rate-limit';
import { href } from '@/lib/href';

const LIST_PATH = '/settings/integrations';

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

type Message = { error?: string; notice?: string };

function listUrl(org: string, message?: Message & { panel?: string; kind?: string }): string {
  return href(LIST_PATH, { org, ...message });
}

function connectionUrl(
  org: string,
  connectionId: string,
  message?: Message & { tab?: string; reveal?: string }
): string {
  return href(`${LIST_PATH}/api/${connectionId}`, { org, ...message });
}

function actionUrl(org: string, connectionId: string, actionId: string, message?: Message): string {
  return href(`${LIST_PATH}/api/${connectionId}/actions/${actionId}`, { org, ...message });
}

/** Owner/admin gate with a readable redirect (RLS is the authoritative check). */
async function requireOwner(org: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', org)
    .eq('user_id', user.id)
    .maybeSingle();
  const role = (data as { role: string } | null)?.role;
  if (role !== 'owner' && role !== 'admin') {
    redirect(listUrl(org, { error: 'Nur Inhaber und Admins können Integrationen verwalten.' }));
  }
}

// --- connection ------------------------------------------------------------------

const connectionFieldsSchema = z.object({
  org: z.uuid(),
  name: z.string().min(2).max(80),
  // validated per connection kind (parseEndpointUrl)
  baseUrl: z.string().min(1).max(500),
  authKind: z.enum(['none', 'bearer', 'header', 'basic']),
  headerName: z.string().max(64),
  username: z.string().max(200),
  secret: z.string().max(4000),
});

function parseConnectionFields(formData: FormData) {
  return connectionFieldsSchema.safeParse({
    org: formData.get('org'),
    name: textField(formData.get('name')),
    baseUrl: textField(formData.get('baseUrl')),
    authKind: textField(formData.get('authKind')) || 'none',
    headerName: textField(formData.get('headerName')),
    username: textField(formData.get('username')),
    // not trimmed away: only surrounding whitespace from a paste is removed
    secret: textField(formData.get('secret')),
  });
}

const CONNECTION_FIELDS_ERROR =
  'Bitte Name (2–80 Zeichen) und eine Basis-URL mit https:// angeben (ohne Zugangsdaten, ohne „?“).';
const MCP_FIELDS_ERROR =
  'Bitte Name (2–80 Zeichen) und die Adresse des MCP-Servers mit https:// angeben (ohne Zugangsdaten, ohne „?“).';
const MCP_NOT_AVAILABLE =
  'MCP-Verbindungen sind noch nicht freigeschaltet (Datenbank-Migration 0039 steht aus).';

function fieldsError(kind: ApiConnectionKind): string {
  return kind === 'mcp' ? MCP_FIELDS_ERROR : CONNECTION_FIELDS_ERROR;
}

/**
 * The address of an end system. REST: a base URL (trailing slash removed, the
 * paths come from the actions). MCP: the server's endpoint exactly as typed.
 */
function parseEndpointUrl(kind: ApiConnectionKind, raw: string): string | null {
  const parsed = (kind === 'mcp' ? mcpEndpointUrlSchema : apiBaseUrlSchema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The kind of a stored connection; before migration 0039 everything is 'http'. */
async function loadConnectionKind(org: string, connectionId: string): Promise<ApiConnectionKind> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('api_connections')
    .select('kind')
    .eq('org_id', org)
    .eq('id', connectionId)
    .maybeSingle();
  return (data as { kind?: string } | null)?.kind === 'mcp' ? 'mcp' : 'http';
}

/**
 * Build the auth part of the config. `existing` lets an update keep the stored
 * secret when the field stays empty and the auth kind did not change.
 */
async function buildAuth(
  fields: z.infer<typeof connectionFieldsSchema>,
  masterKey: string | undefined,
  existing: ApiConnectionAuth | null
): Promise<{ auth: ApiConnectionAuth } | { error: string }> {
  if (fields.authKind === 'none') return { auth: { kind: 'none' } };

  let secretEncrypted: string | null = null;
  if (fields.secret !== '') {
    if (!masterKey) {
      return {
        error: 'Serverseitiger Verschlüsselungsschlüssel fehlt — bitte Administrator kontaktieren.',
      };
    }
    secretEncrypted = await encryptSecret(fields.secret, masterKey);
  } else if (existing && existing.kind !== 'none' && existing.kind === fields.authKind) {
    secretEncrypted = existing.secret_encrypted;
  }
  if (!secretEncrypted) {
    return { error: 'Bitte das Zugangsgeheimnis (Token, Schlüssel oder Passwort) angeben.' };
  }

  const candidate =
    fields.authKind === 'bearer'
      ? { kind: 'bearer' as const, secret_encrypted: secretEncrypted }
      : fields.authKind === 'header'
        ? {
            kind: 'header' as const,
            header_name: fields.headerName,
            secret_encrypted: secretEncrypted,
          }
        : { kind: 'basic' as const, username: fields.username, secret_encrypted: secretEncrypted };
  const parsed = apiConnectionConfigSchema.shape.auth.safeParse(candidate);
  if (!parsed.success) {
    return {
      error:
        fields.authKind === 'header'
          ? 'Bitte einen gültigen Header-Namen angeben (Buchstaben, Ziffern, Bindestrich; z. B. X-API-Key).'
          : 'Bitte einen Benutzernamen angeben.',
    };
  }
  return { auth: parsed.data };
}

export async function createApiConnection(formData: FormData): Promise<void> {
  const org = textField(formData.get('org'));
  const kindParsed = apiConnectionKindSchema.safeParse(textField(formData.get('kind')) || 'http');
  const kind: ApiConnectionKind = kindParsed.success ? kindParsed.data : 'http';
  // the drawer re-opens with the same kind when the form has an error
  const drawerKind = kind === 'mcp' ? 'mcp' : undefined;
  const parsed = parseConnectionFields(formData);
  const baseUrl = parsed.success ? parseEndpointUrl(kind, parsed.data.baseUrl) : null;
  if (!parsed.success || !baseUrl) {
    redirect(listUrl(org, { panel: 'api-new', kind: drawerKind, error: fieldsError(kind) }));
  }
  const fields = parsed.data;
  await requireOwner(fields.org);

  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  // REST connections always get a signing secret; an MCP connection only needs
  // the key when it has credentials (buildAuth reports that itself)
  if (!masterKey && kind === 'http') {
    redirect(
      listUrl(fields.org, {
        panel: 'api-new',
        kind: drawerKind,
        error: 'Serverseitiger Verschlüsselungsschlüssel fehlt — bitte Administrator kontaktieren.',
      })
    );
  }
  const auth = await buildAuth(fields, masterKey, null);
  if ('error' in auth)
    redirect(listUrl(fields.org, { panel: 'api-new', kind: drawerKind, error: auth.error }));

  // Every REST connection gets a signing secret from the start: requests are
  // signed by default, verifying them is the end system's choice. MCP requests
  // are not signed — the signature belongs to the HTTP contract of Phase 13.
  const config: ApiConnectionConfig =
    kind === 'http' && masterKey
      ? {
          auth: auth.auth,
          signing_secret_encrypted: await encryptSecret(generateSigningSecret(), masterKey),
        }
      : { auth: auth.auth };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('api_connections')
    .insert({
      org_id: fields.org,
      name: fields.name,
      base_url: baseUrl,
      config,
      // the 0039 columns are only sent for an MCP connection, so REST
      // connections keep working before the migration; the first read of the
      // tool list starts right away (the worker picks the request up)
      ...(kind === 'mcp' ? { kind: 'mcp', mcp_sync_requested_at: new Date().toISOString() } : {}),
    })
    .select('id')
    .maybeSingle();
  if (error || !data) {
    redirect(
      listUrl(fields.org, {
        panel: 'api-new',
        kind: drawerKind,
        error:
          kind === 'mcp' && error && isMissingColumnError(error)
            ? MCP_NOT_AVAILABLE
            : 'Verbindung konnte nicht gespeichert werden.',
      })
    );
  }

  revalidatePath(LIST_PATH);
  const id = (data as { id: string }).id;
  redirect(
    kind === 'mcp'
      ? connectionUrl(fields.org, id, {
          tab: 'actions',
          notice: 'Verbindung angelegt. Die Werkzeugliste des Servers wird geladen.',
        })
      : connectionUrl(fields.org, id, { notice: 'Verbindung angelegt.' })
  );
}

async function loadConnectionConfig(
  org: string,
  connectionId: string
): Promise<ApiConnectionConfig | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('api_connections')
    .select('config')
    .eq('org_id', org)
    .eq('id', connectionId)
    .maybeSingle();
  if (!data) return null;
  const parsed = apiConnectionConfigSchema.safeParse((data as { config: unknown }).config ?? {});
  return parsed.success ? parsed.data : { auth: { kind: 'none' } };
}

export async function updateApiConnection(formData: FormData): Promise<void> {
  const org = textField(formData.get('org'));
  const idParsed = z.uuid().safeParse(formData.get('connectionId'));
  if (!idParsed.success) redirect(listUrl(org, { error: 'Verbindung nicht gefunden.' }));
  const connectionId = idParsed.data;
  const parsed = parseConnectionFields(formData);
  if (!parsed.success)
    redirect(connectionUrl(org, connectionId, { error: CONNECTION_FIELDS_ERROR }));
  const fields = parsed.data;
  await requireOwner(fields.org);

  const existing = await loadConnectionConfig(fields.org, connectionId);
  if (!existing) redirect(listUrl(fields.org, { error: 'Verbindung nicht gefunden.' }));
  // the kind is fixed at creation — never taken from the form
  const kind = await loadConnectionKind(fields.org, connectionId);
  const baseUrl = parseEndpointUrl(kind, fields.baseUrl);
  if (!baseUrl) redirect(connectionUrl(fields.org, connectionId, { error: fieldsError(kind) }));

  const auth = await buildAuth(fields, process.env.MASTER_ENCRYPTION_KEY, existing.auth);
  if ('error' in auth) redirect(connectionUrl(fields.org, connectionId, { error: auth.error }));

  const config: ApiConnectionConfig = { ...existing, auth: auth.auth };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('api_connections')
    .update({
      name: fields.name,
      base_url: baseUrl,
      config,
      is_active: formData.get('isActive') != null,
      updated_at: new Date().toISOString(),
      // address or credentials may have changed: read the tool list again
      ...(kind === 'mcp' ? { mcp_sync_requested_at: new Date().toISOString() } : {}),
    })
    .eq('org_id', fields.org)
    .eq('id', connectionId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(
      connectionUrl(fields.org, connectionId, {
        error: 'Verbindung konnte nicht gespeichert werden.',
      })
    );
  }

  revalidatePath(LIST_PATH);
  revalidatePath(`${LIST_PATH}/api/${connectionId}`);
  redirect(
    connectionUrl(fields.org, connectionId, {
      notice:
        kind === 'mcp'
          ? 'Verbindung gespeichert. Die Werkzeugliste wird neu geladen.'
          : 'Verbindung gespeichert.',
    })
  );
}

const connectionRefSchema = z.object({ org: z.uuid(), connectionId: z.uuid() });

export async function deleteApiConnection(formData: FormData): Promise<void> {
  const parsed = connectionRefSchema.safeParse({
    org: formData.get('org'),
    connectionId: formData.get('connectionId'),
  });
  if (!parsed.success)
    redirect(listUrl(textField(formData.get('org')), { error: 'Verbindung nicht gefunden.' }));
  const { org, connectionId } = parsed.data;
  await requireOwner(org);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('api_connections')
    .delete()
    .eq('org_id', org)
    .eq('id', connectionId);
  if (error) {
    redirect(
      connectionUrl(org, connectionId, { error: 'Verbindung konnte nicht gelöscht werden.' })
    );
  }
  revalidatePath(LIST_PATH);
  redirect(listUrl(org, { notice: 'Verbindung gelöscht.' }));
}

/** Replace the signing secret; the new one is shown once right after (reveal). */
export async function rotateSigningSecret(formData: FormData): Promise<void> {
  const parsed = connectionRefSchema.safeParse({
    org: formData.get('org'),
    connectionId: formData.get('connectionId'),
  });
  if (!parsed.success)
    redirect(listUrl(textField(formData.get('org')), { error: 'Verbindung nicht gefunden.' }));
  const { org, connectionId } = parsed.data;
  await requireOwner(org);

  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  const existing = await loadConnectionConfig(org, connectionId);
  if (!masterKey || !existing) {
    redirect(
      connectionUrl(org, connectionId, {
        error: 'Signatur-Schlüssel konnte nicht erneuert werden.',
      })
    );
  }
  const config: ApiConnectionConfig = {
    ...existing,
    signing_secret_encrypted: await encryptSecret(generateSigningSecret(), masterKey),
  };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('api_connections')
    .update({ config, updated_at: new Date().toISOString() })
    .eq('org_id', org)
    .eq('id', connectionId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(
      connectionUrl(org, connectionId, {
        error: 'Signatur-Schlüssel konnte nicht erneuert werden.',
      })
    );
  }
  revalidatePath(`${LIST_PATH}/api/${connectionId}`);
  redirect(
    connectionUrl(org, connectionId, {
      reveal: 'signing',
      notice: 'Neuer Signatur-Schlüssel erzeugt. Der alte ist ab sofort ungültig.',
    })
  );
}

// --- outbound events (Phase 13c) ---------------------------------------------------

export async function saveEventSettings(formData: FormData): Promise<void> {
  const parsed = connectionRefSchema.safeParse({
    org: formData.get('org'),
    connectionId: formData.get('connectionId'),
  });
  if (!parsed.success)
    redirect(listUrl(textField(formData.get('org')), { error: 'Verbindung nicht gefunden.' }));
  const { org, connectionId } = parsed.data;
  await requireOwner(org);

  const rawUrl = textField(formData.get('eventUrl'));
  const url = rawUrl === '' ? null : apiEventUrlSchema.safeParse(rawUrl);
  if (url !== null && !url.success) {
    redirect(
      connectionUrl(org, connectionId, {
        tab: 'events',
        error: 'Bitte eine Adresse mit https:// angeben (ohne Zugangsdaten in der URL).',
      })
    );
  }
  const types = integrationEventTypesSchema.safeParse(
    formData.getAll('eventTypes').filter((entry): entry is string => typeof entry === 'string')
  );
  if (!types.success) {
    redirect(
      connectionUrl(org, connectionId, { tab: 'events', error: 'Unbekannter Ereignistyp.' })
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('api_connections')
    .update({
      event_url: url === null ? null : url.data,
      event_types: types.data,
      updated_at: new Date().toISOString(),
    })
    .eq('org_id', org)
    .eq('id', connectionId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(
      connectionUrl(org, connectionId, {
        tab: 'events',
        error: 'Ereignis-Einstellungen konnten nicht gespeichert werden.',
      })
    );
  }
  revalidatePath(`${LIST_PATH}/api/${connectionId}`);
  redirect(connectionUrl(org, connectionId, { tab: 'events', notice: 'Ereignisse gespeichert.' }));
}

/** Queue a `ping` event so the receiver and its signature check can be tested. */
export async function sendTestEvent(formData: FormData): Promise<void> {
  const parsed = connectionRefSchema.safeParse({
    org: formData.get('org'),
    connectionId: formData.get('connectionId'),
  });
  if (!parsed.success)
    redirect(listUrl(textField(formData.get('org')), { error: 'Verbindung nicht gefunden.' }));
  const { org, connectionId } = parsed.data;
  await requireOwner(org);

  const supabase = await createSupabaseServerClient();
  // SECURITY DEFINER function: checks owner/admin and that an event URL exists.
  const { error } = await supabase.rpc('request_integration_ping', {
    p_connection_id: connectionId,
  });
  if (error) {
    redirect(
      connectionUrl(org, connectionId, {
        tab: 'events',
        error: 'Test-Ereignis konnte nicht gesendet werden. Ist eine Ereignis-Adresse gespeichert?',
      })
    );
  }
  revalidatePath(`${LIST_PATH}/api/${connectionId}`);
  redirect(
    connectionUrl(org, connectionId, {
      tab: 'events',
      notice: 'Test-Ereignis ist unterwegs. Das Ergebnis erscheint gleich im Zustellprotokoll.',
    })
  );
}

// --- API keys (Phase 13d) -----------------------------------------------------------

export type CreateApiKeyResult = { key: string; prefix: string } | { error: string };

/**
 * Create an API key for one connection. The key is returned ONCE to the page
 * that asked for it and never stored — only its SHA-256 goes to the database.
 * Returns instead of redirecting, because a secret must not travel in a URL.
 */
export async function createApiKey(
  org: string,
  connectionId: string,
  name: string
): Promise<CreateApiKeyResult> {
  const parsed = z
    .object({ org: z.uuid(), connectionId: z.uuid(), name: z.string().trim().min(2).max(80) })
    .safeParse({ org, connectionId, name });
  if (!parsed.success) return { error: 'Bitte einen Namen mit 2–80 Zeichen angeben.' };

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Bitte neu anmelden.' };

  const generated = generateApiKey();
  // RLS (api_keys_insert) is the authoritative owner/admin check.
  const { error } = await supabase.from('api_keys').insert({
    org_id: parsed.data.org,
    connection_id: parsed.data.connectionId,
    name: parsed.data.name,
    key_prefix: generated.prefix,
    key_hash: generated.hash,
    created_by: user.id,
  });
  if (error) {
    return { error: 'Schlüssel konnte nicht angelegt werden (nur Inhaber und Admins).' };
  }
  revalidatePath(`${LIST_PATH}/api/${parsed.data.connectionId}`);
  return { key: generated.key, prefix: generated.prefix };
}

export async function revokeApiKey(formData: FormData): Promise<void> {
  const parsed = z.object({ org: z.uuid(), connectionId: z.uuid(), keyId: z.uuid() }).safeParse({
    org: formData.get('org'),
    connectionId: formData.get('connectionId'),
    keyId: formData.get('keyId'),
  });
  if (!parsed.success)
    redirect(listUrl(textField(formData.get('org')), { error: 'Schlüssel nicht gefunden.' }));
  const { org, connectionId, keyId } = parsed.data;
  await requireOwner(org);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('org_id', org)
    .eq('connection_id', connectionId)
    .eq('id', keyId)
    .is('revoked_at', null)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(
      connectionUrl(org, connectionId, {
        tab: 'keys',
        error: 'Schlüssel konnte nicht widerrufen werden.',
      })
    );
  }
  revalidatePath(`${LIST_PATH}/api/${connectionId}`);
  redirect(
    connectionUrl(org, connectionId, {
      tab: 'keys',
      notice: 'Schlüssel widerrufen. Anfragen damit werden ab sofort abgelehnt.',
    })
  );
}

// --- data actions ----------------------------------------------------------------

const DEFINITION_ISSUE_TEXT: Record<DataActionDefinitionIssue, string> = {
  placeholder_without_parameter:
    'Im Pfad steht ein Platzhalter in {Klammern}, zu dem kein Parameter mit Ort „Pfad“ existiert.',
  path_parameter_without_placeholder:
    'Ein Parameter hat den Ort „Pfad“, sein Name kommt aber nicht als {Platzhalter} im Pfad vor.',
  body_parameter_on_bodyless_method:
    'GET und DELETE senden keinen Body — bitte die Parameter auf „Query“ oder „Pfad“ stellen.',
};

function parseJsonField(value: FormDataEntryValue | null): unknown {
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** One response field per line (or comma-separated). */
function parseResponseFields(value: FormDataEntryValue | null): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export async function saveDataAction(formData: FormData): Promise<void> {
  const refParsed = connectionRefSchema.safeParse({
    org: formData.get('org'),
    connectionId: formData.get('connectionId'),
  });
  if (!refParsed.success)
    redirect(listUrl(textField(formData.get('org')), { error: 'Verbindung nicht gefunden.' }));
  const { org, connectionId } = refParsed.data;
  const rawActionId = textField(formData.get('actionId'));
  const actionId = z.uuid().safeParse(rawActionId).success ? rawActionId : null;
  const backId = actionId ?? 'new';
  await requireOwner(org);

  const supabase = await createSupabaseServerClient();
  // Phase 14a: an imported MCP tool has no method/path of its own — whether the
  // action is one comes from the stored row, never from the form. The select
  // fails before migration 0039 (no column) and then means "not an MCP action".
  let isMcpAction = false;
  if (actionId) {
    const { data: stored } = await supabase
      .from('data_actions')
      .select('mcp_tool_name')
      .eq('org_id', org)
      .eq('id', actionId)
      .maybeSingle();
    isMcpAction = Boolean((stored as { mcp_tool_name?: string | null } | null)?.mcp_tool_name);
  } else if ((await loadConnectionKind(org, connectionId)) === 'mcp') {
    redirect(
      connectionUrl(org, connectionId, {
        tab: 'actions',
        error: 'Aktionen einer MCP-Verbindung entstehen durch den Import eines Werkzeugs.',
      })
    );
  }

  const kind = textField(formData.get('kind'));
  const parsed = dataActionDefinitionSchema.safeParse({
    name: textField(formData.get('name')),
    label: textField(formData.get('label')),
    description: textField(formData.get('description')),
    kind,
    method: isMcpAction ? MCP_ACTION_METHOD : textField(formData.get('method')),
    path: isMcpAction ? MCP_ACTION_PATH : textField(formData.get('path')),
    parameters: parseJsonField(formData.get('parameters')),
    responseFields: parseResponseFields(formData.get('responseFields')),
    // only write actions can wait for a confirmation
    requiresConfirmation: kind === 'write' && formData.get('requiresConfirmation') != null,
    timeoutMs: Math.round(Number(textField(formData.get('timeoutSeconds')) || '8') * 1000),
  });
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? '');
    const hint: Record<string, string> = {
      name: 'Technischer Name: 3–40 Zeichen, nur Kleinbuchstaben, Ziffern und „_“, beginnt mit einem Buchstaben (z. B. bestellstatus_abfragen).',
      label: 'Bitte eine Bezeichnung mit 2–80 Zeichen angeben.',
      description:
        'Bitte beschreiben, was die Aktion tut und wann der Agent sie nutzen soll (10–1000 Zeichen).',
      path: 'Der Pfad beginnt mit „/“, enthält kein „?“ und Platzhalter in der Form {name}.',
      parameters:
        'Bitte die Parameter prüfen: eindeutige Namen (Kleinbuchstaben, Ziffern, „_“), bei „Kontext“ eine Quelle, bei „Fester Wert“ einen Wert.',
      responseFields:
        'Antwortfelder sind Punkt-Pfade wie status oder order.items.name — ein Feld pro Zeile.',
      timeoutMs: 'Das Zeitlimit liegt zwischen 1 und 20 Sekunden.',
    };
    redirect(
      actionUrl(org, connectionId, backId, {
        error: hint[field] ?? 'Bitte die Eingaben der Aktion prüfen.',
      })
    );
  }
  const def = parsed.data;
  const issue = checkDataActionDefinition(def);
  if (issue)
    redirect(actionUrl(org, connectionId, backId, { error: DEFINITION_ISSUE_TEXT[issue] }));
  if (isMcpAction && !isMcpParameterList(def.parameters)) {
    redirect(
      actionUrl(org, connectionId, backId, {
        error: 'Die Parameter eines MCP-Werkzeugs sind immer Argumente des Aufrufs.',
      })
    );
  }

  const row = {
    name: def.name,
    label: def.label,
    description: def.description,
    kind: def.kind,
    method: def.method,
    path: def.path,
    parameters: def.parameters,
    response_fields: def.responseFields,
    requires_confirmation: def.requiresConfirmation,
    timeout_ms: def.timeoutMs,
    is_active: formData.get('isActive') != null,
    updated_at: new Date().toISOString(),
  };

  let savedId = actionId;
  let dbError: { code?: string } | null = null;
  if (actionId) {
    const { data, error } = await supabase
      .from('data_actions')
      .update(row)
      .eq('org_id', org)
      .eq('id', actionId)
      .select('id');
    dbError = error;
    if (!error && (!data || data.length === 0)) dbError = {};
  } else {
    const { data, error } = await supabase
      .from('data_actions')
      .insert({ ...row, org_id: org, connection_id: connectionId })
      .select('id')
      .maybeSingle();
    dbError = error;
    savedId = (data as { id: string } | null)?.id ?? null;
    if (!error && !savedId) dbError = {};
  }
  if (dbError) {
    redirect(
      actionUrl(org, connectionId, backId, {
        error:
          dbError.code === '23505'
            ? 'Dieser technische Name ist in der Organisation bereits vergeben.'
            : 'Aktion konnte nicht gespeichert werden.',
      })
    );
  }

  revalidatePath(`${LIST_PATH}/api/${connectionId}`);
  revalidatePath('/settings/agents');
  redirect(actionUrl(org, connectionId, savedId as string, { notice: 'Aktion gespeichert.' }));
}

export async function deleteDataAction(formData: FormData): Promise<void> {
  const parsed = z.object({ org: z.uuid(), connectionId: z.uuid(), actionId: z.uuid() }).safeParse({
    org: formData.get('org'),
    connectionId: formData.get('connectionId'),
    actionId: formData.get('actionId'),
  });
  if (!parsed.success)
    redirect(listUrl(textField(formData.get('org')), { error: 'Aktion nicht gefunden.' }));
  const { org, connectionId, actionId } = parsed.data;
  await requireOwner(org);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('data_actions')
    .delete()
    .eq('org_id', org)
    .eq('id', actionId);
  if (error) {
    redirect(
      actionUrl(org, connectionId, actionId, { error: 'Aktion konnte nicht gelöscht werden.' })
    );
  }
  revalidatePath(`${LIST_PATH}/api/${connectionId}`);
  revalidatePath('/settings/agents');
  redirect(connectionUrl(org, connectionId, { tab: 'actions', notice: 'Aktion gelöscht.' }));
}

// --- test run --------------------------------------------------------------------

export interface ActionRunView {
  id: string;
  state: string;
  httpStatus: number | null;
  latencyMs: number | null;
  errorCode: string | null;
  result: unknown;
}

export type StartTestResult = { runId: string } | { error: string };

/**
 * Queue a test run with explicit values. The WORKER performs the call (same
 * code path and egress IP as an agent call); the page polls getActionRun.
 */
export async function startActionTest(
  org: string,
  actionId: string,
  values: Record<string, string>
): Promise<StartTestResult> {
  if (!z.uuid().safeParse(org).success || !z.uuid().safeParse(actionId).success) {
    return { error: 'Aktion nicht gefunden.' };
  }
  const supabase = await createSupabaseServerClient();
  const { data: action } = await supabase
    .from('data_actions')
    .select('parameters')
    .eq('org_id', org)
    .eq('id', actionId)
    .maybeSingle();
  const parameters = dataActionParametersSchema.safeParse(
    (action as { parameters: unknown } | null)?.parameters ?? null
  );
  if (!action || !parameters.success) return { error: 'Aktion nicht gefunden.' };

  const coerced = coerceActionValues(parameters.data, values);
  if (!coerced.ok) {
    return { error: `Der Wert für „${coerced.key}“ fehlt oder passt nicht zum Typ.` };
  }

  // SECURITY DEFINER function: checks owner/admin and inserts the queued run.
  const { data: runId, error } = await supabase.rpc('request_action_test', {
    p_action_id: actionId,
    p_args: coerced.values,
  });
  if (error || typeof runId !== 'string') {
    return { error: 'Testlauf konnte nicht gestartet werden (nur Inhaber und Admins).' };
  }
  return { runId };
}

/** Poll target of the test panel (RLS: members of the org only). */
export async function getActionRun(org: string, runId: string): Promise<ActionRunView | null> {
  if (!z.uuid().safeParse(org).success || !z.uuid().safeParse(runId).success) return null;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('action_runs')
    .select('id, state, http_status, latency_ms, error_code, result')
    .eq('org_id', org)
    .eq('id', runId)
    .maybeSingle();
  if (!data) return null;
  const row = data as {
    id: string;
    state: string;
    http_status: number | null;
    latency_ms: number | null;
    error_code: string | null;
    result: unknown;
  };
  return {
    id: row.id,
    state: row.state,
    httpStatus: row.http_status,
    latencyMs: row.latency_ms,
    errorCode: row.error_code,
    result: row.result,
  };
}

// --- MCP connections (Phase 14a) -----------------------------------------------------
// The web app never talks to a customer's MCP server. It asks for a read of the
// tool list (a timestamp the worker picks up) and works with the snapshot the
// worker stored in api_connections.mcp_catalog.

const toolsTab = { tab: 'actions' } as const;

/** Ask the worker to read the server's tool list again. */
export async function requestMcpSync(formData: FormData): Promise<void> {
  const parsed = connectionRefSchema.safeParse({
    org: formData.get('org'),
    connectionId: formData.get('connectionId'),
  });
  if (!parsed.success)
    redirect(listUrl(textField(formData.get('org')), { error: 'Verbindung nicht gefunden.' }));
  const { org, connectionId } = parsed.data;
  await requireOwner(org);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  if (!(await checkRateLimit('mcp-sync-user', user.id))) {
    redirect(
      connectionUrl(org, connectionId, {
        ...toolsTab,
        error: 'Zu viele Aktualisierungen — bitte in ein paar Minuten erneut.',
      })
    );
  }

  const { data, error } = await supabase
    .from('api_connections')
    .update({ mcp_sync_requested_at: new Date().toISOString() })
    .eq('org_id', org)
    .eq('id', connectionId)
    .eq('kind', 'mcp')
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(
      connectionUrl(org, connectionId, {
        ...toolsTab,
        error: 'Die Werkzeugliste konnte nicht angefordert werden.',
      })
    );
  }
  revalidatePath(`${LIST_PATH}/api/${connectionId}`);
  // no notice: the page shows the running read and refreshes itself
  redirect(connectionUrl(org, connectionId, toolsTab));
}

export interface McpSyncState {
  /** A read is requested or running. */
  pending: boolean;
  syncedAt: string | null;
  error: string | null;
}

/** Poll target while a read of the tool list is running (RLS: owner/admin only). */
export async function getMcpSyncState(
  org: string,
  connectionId: string
): Promise<McpSyncState | null> {
  if (!z.uuid().safeParse(org).success || !z.uuid().safeParse(connectionId).success) return null;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('api_connections')
    .select('mcp_sync_requested_at, mcp_synced_at, mcp_sync_error')
    .eq('org_id', org)
    .eq('id', connectionId)
    .maybeSingle();
  if (!data) return null;
  const row = data as {
    mcp_sync_requested_at: string | null;
    mcp_synced_at: string | null;
    mcp_sync_error: string | null;
  };
  return {
    pending: row.mcp_sync_requested_at !== null,
    syncedAt: row.mcp_synced_at,
    error: row.mcp_sync_error,
  };
}

/** One tool from the stored snapshot of an MCP connection, or null. */
async function loadCatalogTool(
  org: string,
  connectionId: string,
  toolName: string
): Promise<McpCatalogTool | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('api_connections')
    .select('kind, mcp_catalog')
    .eq('org_id', org)
    .eq('id', connectionId)
    .maybeSingle();
  const row = data as { kind?: string; mcp_catalog?: unknown } | null;
  if (!row || row.kind !== 'mcp') return null;
  const catalog = mcpCatalogSchema.safeParse(row.mcp_catalog ?? null);
  if (!catalog.success) return null;
  return catalog.data.tools.find((tool) => tool.name === toolName) ?? null;
}

/**
 * Import one tool of the server as a data action. The action is a SNAPSHOT:
 * name, description and parameters are copied and belong to the owner from
 * here on — the agent never sees the server's live definition. Cautious
 * defaults (write + confirmation unless the server marks the tool read-only);
 * the owner reviews them in the editor the import redirects to.
 */
export async function importMcpTool(formData: FormData): Promise<void> {
  const parsed = z
    .object({ org: z.uuid(), connectionId: z.uuid(), tool: z.string().min(1).max(200) })
    .safeParse({
      org: formData.get('org'),
      connectionId: formData.get('connectionId'),
      tool: formData.get('tool'),
    });
  if (!parsed.success)
    redirect(listUrl(textField(formData.get('org')), { error: 'Werkzeug nicht gefunden.' }));
  const { org, connectionId } = parsed.data;
  await requireOwner(org);

  const tool = await loadCatalogTool(org, connectionId, parsed.data.tool);
  if (!tool) {
    redirect(
      connectionUrl(org, connectionId, {
        ...toolsTab,
        error:
          'Das Werkzeug steht nicht (mehr) in der Werkzeugliste. Bitte die Liste aktualisieren.',
      })
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: existingRows } = await supabase
    .from('data_actions')
    .select('id, name, connection_id, mcp_tool_name')
    .eq('org_id', org);
  const existing = (existingRows ?? []) as {
    id: string;
    name: string;
    connection_id: string;
    mcp_tool_name: string | null;
  }[];
  const already = existing.find(
    (row) => row.connection_id === connectionId && row.mcp_tool_name === tool.name
  );
  if (already) {
    redirect(
      actionUrl(org, connectionId, already.id, {
        notice: 'Dieses Werkzeug ist bereits importiert.',
      })
    );
  }

  const drafted = draftActionFromMcpTool(
    tool,
    existing.map((row) => row.name)
  );
  if (!drafted.ok) {
    redirect(
      connectionUrl(org, connectionId, {
        ...toolsTab,
        error: `„${tool.name}“ kann nicht importiert werden: ${MCP_IMPORT_ISSUE_LABELS[drafted.issue]}`,
      })
    );
  }
  const draft = drafted.draft;

  const { data, error } = await supabase
    .from('data_actions')
    .insert({
      org_id: org,
      connection_id: connectionId,
      name: draft.name,
      label: draft.label,
      description: draft.description,
      kind: draft.kind,
      method: MCP_ACTION_METHOD,
      path: MCP_ACTION_PATH,
      parameters: draft.parameters,
      response_fields: [],
      requires_confirmation: draft.requiresConfirmation,
      timeout_ms: MCP_ACTION_TIMEOUT_DEFAULT_MS,
      is_active: true,
      mcp_tool_name: tool.name,
      mcp_tool_hash: tool.hash,
    })
    .select('id')
    .maybeSingle();
  if (error || !data) {
    redirect(
      connectionUrl(org, connectionId, {
        ...toolsTab,
        error: 'Das Werkzeug konnte nicht importiert werden.',
      })
    );
  }

  revalidatePath(`${LIST_PATH}/api/${connectionId}`);
  revalidatePath('/settings/agents');
  const dropped =
    draft.dropped.length > 0
      ? ` Nicht übernommen (optionale Argumente, die Aktionen nicht abbilden): ${draft.dropped
          .slice(0, 6)
          .join(', ')}${draft.dropped.length > 6 ? ' …' : ''}.`
      : '';
  redirect(
    actionUrl(org, connectionId, (data as { id: string }).id, {
      notice: `Werkzeug importiert. Bitte Beschreibung, Art und Parameter prüfen und die Aktion danach am Agenten freigeben.${dropped}`,
    })
  );
}

/**
 * Decide about a tool the server changed after the import:
 *   · reimport     take the server's current description and arguments (the
 *                  owner's bindings — context values, fixed values, names —
 *                  are kept per argument)
 *   · acknowledge  keep the imported definition and stop flagging this change
 */
export async function resolveMcpDrift(formData: FormData): Promise<void> {
  const parsed = z
    .object({
      org: z.uuid(),
      connectionId: z.uuid(),
      actionId: z.uuid(),
      mode: z.enum(['reimport', 'acknowledge']),
    })
    .safeParse({
      org: formData.get('org'),
      connectionId: formData.get('connectionId'),
      actionId: formData.get('actionId'),
      mode: formData.get('mode'),
    });
  if (!parsed.success)
    redirect(listUrl(textField(formData.get('org')), { error: 'Aktion nicht gefunden.' }));
  const { org, connectionId, actionId, mode } = parsed.data;
  await requireOwner(org);

  const supabase = await createSupabaseServerClient();
  const { data: actionRow } = await supabase
    .from('data_actions')
    .select('id, mcp_tool_name, parameters')
    .eq('org_id', org)
    .eq('connection_id', connectionId)
    .eq('id', actionId)
    .maybeSingle();
  const action = actionRow as {
    id: string;
    mcp_tool_name: string | null;
    parameters: unknown;
  } | null;
  if (!action?.mcp_tool_name) {
    redirect(actionUrl(org, connectionId, actionId, { error: 'Aktion nicht gefunden.' }));
  }

  const tool = await loadCatalogTool(org, connectionId, action.mcp_tool_name);
  if (!tool) {
    redirect(
      actionUrl(org, connectionId, actionId, {
        error:
          'Der Server bietet dieses Werkzeug nicht mehr an. Aktualisiere die Werkzeugliste oder lösche die Aktion.',
      })
    );
  }

  let update: Record<string, unknown> = { mcp_tool_hash: tool.hash, mcp_drift: null };
  if (mode === 'reimport') {
    const drafted = draftActionFromMcpTool(tool, []);
    if (!drafted.ok) {
      redirect(
        actionUrl(org, connectionId, actionId, {
          error: `Die neue Fassung kann nicht übernommen werden: ${MCP_IMPORT_ISSUE_LABELS[drafted.issue]}`,
        })
      );
    }
    const previous = dataActionParametersSchema.safeParse(action.parameters);
    update = {
      ...update,
      description: drafted.draft.description,
      parameters: previous.success
        ? mergeReimportedParameters(previous.data, drafted.draft.parameters)
        : drafted.draft.parameters,
    };
  }

  const { data, error } = await supabase
    .from('data_actions')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('org_id', org)
    .eq('id', actionId)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(
      actionUrl(org, connectionId, actionId, {
        error: 'Die Aktion konnte nicht aktualisiert werden.',
      })
    );
  }
  revalidatePath(`${LIST_PATH}/api/${connectionId}`);
  revalidatePath('/settings/agents');
  redirect(
    actionUrl(org, connectionId, actionId, {
      notice:
        mode === 'reimport'
          ? 'Neue Fassung des Werkzeugs übernommen. Bitte Beschreibung und Parameter prüfen.'
          : 'Als geprüft markiert. Die Aktion nutzt weiter die hier gespeicherte Fassung.',
    })
  );
}
