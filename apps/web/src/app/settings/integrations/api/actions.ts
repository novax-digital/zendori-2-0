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
  apiBaseUrlSchema,
  apiConnectionConfigSchema,
  apiEventUrlSchema,
  integrationEventTypesSchema,
  checkDataActionDefinition,
  coerceActionValues,
  dataActionDefinitionSchema,
  dataActionParametersSchema,
  encryptSecret,
  generateApiKey,
  type ApiConnectionAuth,
  type ApiConnectionConfig,
  type DataActionDefinitionIssue,
} from '@zendori/core';
import { generateSigningSecret } from '@zendori/integrations';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { href } from '@/lib/href';

const LIST_PATH = '/settings/integrations';

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

type Message = { error?: string; notice?: string };

function listUrl(org: string, message?: Message & { panel?: string }): string {
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
  baseUrl: apiBaseUrlSchema,
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
  const parsed = parseConnectionFields(formData);
  if (!parsed.success) redirect(listUrl(org, { panel: 'api-new', error: CONNECTION_FIELDS_ERROR }));
  const fields = parsed.data;
  await requireOwner(fields.org);

  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  if (!masterKey) {
    redirect(
      listUrl(fields.org, {
        panel: 'api-new',
        error: 'Serverseitiger Verschlüsselungsschlüssel fehlt — bitte Administrator kontaktieren.',
      })
    );
  }
  const auth = await buildAuth(fields, masterKey, null);
  if ('error' in auth) redirect(listUrl(fields.org, { panel: 'api-new', error: auth.error }));

  // Every connection gets a signing secret from the start: requests are signed
  // by default, verifying them is the end system's choice.
  const config: ApiConnectionConfig = {
    auth: auth.auth,
    signing_secret_encrypted: await encryptSecret(generateSigningSecret(), masterKey),
  };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('api_connections')
    .insert({ org_id: fields.org, name: fields.name, base_url: fields.baseUrl, config })
    .select('id')
    .maybeSingle();
  if (error || !data) {
    redirect(
      listUrl(fields.org, {
        panel: 'api-new',
        error: 'Verbindung konnte nicht gespeichert werden.',
      })
    );
  }

  revalidatePath(LIST_PATH);
  redirect(
    connectionUrl(fields.org, (data as { id: string }).id, { notice: 'Verbindung angelegt.' })
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

  const auth = await buildAuth(fields, process.env.MASTER_ENCRYPTION_KEY, existing.auth);
  if ('error' in auth) redirect(connectionUrl(fields.org, connectionId, { error: auth.error }));

  const config: ApiConnectionConfig = { ...existing, auth: auth.auth };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('api_connections')
    .update({
      name: fields.name,
      base_url: fields.baseUrl,
      config,
      is_active: formData.get('isActive') != null,
      updated_at: new Date().toISOString(),
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
  redirect(connectionUrl(fields.org, connectionId, { notice: 'Verbindung gespeichert.' }));
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

  const kind = textField(formData.get('kind'));
  const parsed = dataActionDefinitionSchema.safeParse({
    name: textField(formData.get('name')),
    label: textField(formData.get('label')),
    description: textField(formData.get('description')),
    kind,
    method: textField(formData.get('method')),
    path: textField(formData.get('path')),
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

  const supabase = await createSupabaseServerClient();
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
