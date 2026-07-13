'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { encryptSecret, syncRulesSchema } from '@zendori/core';
import type { SyncRules } from '@zendori/core';
import {
  getAccountInfo,
  listTicketPipelines,
  provisionTicketProperties,
} from '@zendori/integrations';
import { createSupabaseServerClient } from '@/lib/supabase/server';

// --- helpers -----------------------------------------------------------------

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function integrationsUrl(org: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/settings/integrations?${params.toString()}`;
}

/** Reads the numeric HTTP status off a thrown HubSpot client error, if present. */
function hubspotErrorStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

/** Maps a HubSpot client error to a German, token-free message (never logs the token). */
function mapHubspotError(err: unknown): string {
  const status = hubspotErrorStatus(err);
  if (status === 401) {
    return 'HubSpot hat den Token abgelehnt (401). Bitte den Private-App-Token prüfen.';
  }
  if (status === 403) {
    return 'Dem Token fehlen Berechtigungen (403). Die Private App braucht die Scopes „tickets", „crm.objects.contacts.read" und „crm.objects.contacts.write".';
  }
  return 'Verbindung zu HubSpot fehlgeschlagen. Bitte Token und Scopes prüfen.';
}

// Account-info + pipelines come from the network → parsed defensively here.
// Accepts camelCase and snake_case so the exact client return shape is not
// load-bearing (only the function names + { token } config are contracted).
const accountInfoSchema = z
  .object({
    portalId: z.union([z.number(), z.string()]).optional(),
    portal_id: z.union([z.number(), z.string()]).optional(),
    uiDomain: z.string().optional(),
    ui_domain: z.string().optional(),
  })
  .passthrough();

const pipelineDefaultsSchema = z.array(
  z
    .object({
      id: z.union([z.number(), z.string()]),
      stages: z.array(z.object({ id: z.union([z.number(), z.string()]) }).passthrough()).optional(),
    })
    .passthrough()
);

/** First pipeline + first stage id — a sensible default the worker can create tickets with. */
function firstPipelineDefaults(pipelinesRaw: unknown): { pipelineId: string; stageId: string } {
  const parsed = pipelineDefaultsSchema.safeParse(pipelinesRaw);
  const first = parsed.success ? parsed.data[0] : undefined;
  if (!first) return { pipelineId: '', stageId: '' };
  const firstStage = first.stages?.[0];
  return { pipelineId: String(first.id), stageId: firstStage ? String(firstStage.id) : '' };
}

// --- connect -----------------------------------------------------------------

const connectSchema = z.object({
  org: z.uuid(),
  token: z.string().min(1),
});

/**
 * Verifies a HubSpot Private-App token (account-info + pipelines), provisions
 * the custom ticket properties, then stores the token ENCRYPTED. The plaintext
 * token is used only transiently for the client calls — never persisted in the
 * clear, never rendered, never logged. Rules default to `manual` on a fresh
 * connect; a re-connect (token rotation) keeps existing pipeline/rules.
 */
export async function connectHubspot(formData: FormData): Promise<void> {
  const org = textField(formData.get('org'));
  const parsed = connectSchema.safeParse({
    org,
    token: textField(formData.get('token')),
  });
  if (!parsed.success) {
    redirect(integrationsUrl(org, { error: 'Bitte einen gültigen Private-App-Token angeben.' }));
  }
  const { org: orgId, token } = parsed.data;

  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  if (!masterKey) {
    redirect(
      integrationsUrl(orgId, {
        error: 'Serverseitiger Verschlüsselungsschlüssel fehlt — bitte Administrator kontaktieren.',
      })
    );
  }

  const clientConfig = { token };

  // 1. verify the token before storing anything + read deep-link + default ids
  let uiDomain = '';
  let portalId = '';
  let defaults = { pipelineId: '', stageId: '' };
  try {
    const accountRaw = await getAccountInfo(clientConfig);
    const pipelinesRaw = await listTicketPipelines(clientConfig);
    const account = accountInfoSchema.safeParse(accountRaw);
    if (account.success) {
      uiDomain = account.data.uiDomain ?? account.data.ui_domain ?? '';
      portalId = String(account.data.portalId ?? account.data.portal_id ?? '');
    }
    defaults = firstPipelineDefaults(pipelinesRaw);
  } catch (err) {
    redirect(integrationsUrl(orgId, { error: mapHubspotError(err) }));
  }

  // 2. provision the custom ticket properties (zendori_ref / zendori_source)
  try {
    await provisionTicketProperties(clientConfig);
  } catch {
    redirect(
      integrationsUrl(orgId, {
        error:
          'HubSpot-Verbindung steht, aber die Zendori-Ticket-Eigenschaften konnten nicht angelegt werden. Bitte prüfen, ob der Token den Scope „tickets" besitzt.',
      })
    );
  }

  // 3. encrypt the token and upsert (read-modify-write: keep existing
  //    pipeline/rules on a re-connect, default rules to manual on first connect)
  const tokenEncrypted = await encryptSecret(token, masterKey);

  const supabase = await createSupabaseServerClient();
  const { data: existing } = await supabase
    .from('integrations')
    .select('config, rules')
    .eq('org_id', orgId)
    .eq('type', 'hubspot')
    .maybeSingle();
  const existingConfig = (existing?.config ?? {}) as Record<string, unknown>;
  const existingRules = existing?.rules;

  const keepPipeline =
    typeof existingConfig.pipeline_id === 'string' && existingConfig.pipeline_id !== '';
  const keepStage =
    typeof existingConfig.default_stage_id === 'string' && existingConfig.default_stage_id !== '';

  const config: Record<string, unknown> = {
    token_encrypted: tokenEncrypted,
    pipeline_id: keepPipeline ? existingConfig.pipeline_id : defaults.pipelineId,
    default_stage_id: keepStage ? existingConfig.default_stage_id : defaults.stageId,
    ui_domain: uiDomain,
    portal_id: portalId,
  };
  if (typeof existingConfig.resolved_stage_id === 'string') {
    config.resolved_stage_id = existingConfig.resolved_stage_id;
  }

  const rules: SyncRules = syncRulesSchema.safeParse(existingRules).success
    ? (existingRules as SyncRules)
    : { mode: 'manual' };

  const { data, error } = await supabase
    .from('integrations')
    .upsert(
      { org_id: orgId, type: 'hubspot', config, rules, is_active: true },
      { onConflict: 'org_id,type' }
    )
    .select('org_id');
  if (error || !data || data.length === 0) {
    redirect(integrationsUrl(orgId, { error: 'Integration konnte nicht gespeichert werden.' }));
  }

  revalidatePath('/settings/integrations');
  redirect(integrationsUrl(orgId, { notice: 'HubSpot verbunden.' }));
}

// --- save config -------------------------------------------------------------

const saveConfigSchema = z.object({
  org: z.uuid(),
  pipeline_id: z.string(),
  default_stage_id: z.string(),
  resolved_stage_id: z.string(),
  rules_mode: z.enum(['all', 'channels', 'manual']),
});

/**
 * Updates pipeline/stage + sync rules + active flag via config read-modify-write
 * (token_encrypted / ui_domain / portal_id are preserved, never touched here).
 * User-scoped client — the `integrations_all` RLS policy limits writes to members.
 */
export async function saveHubspotConfig(formData: FormData): Promise<void> {
  const org = textField(formData.get('org'));
  const parsed = saveConfigSchema.safeParse({
    org,
    pipeline_id: textField(formData.get('pipeline_id')),
    default_stage_id: textField(formData.get('default_stage_id')),
    resolved_stage_id: textField(formData.get('resolved_stage_id')),
    rules_mode: textField(formData.get('rules_mode')),
  });
  if (!parsed.success) {
    redirect(
      integrationsUrl(org, { error: 'Die Einstellungen konnten nicht gespeichert werden.' })
    );
  }
  const { org: orgId, pipeline_id, default_stage_id, resolved_stage_id, rules_mode } = parsed.data;
  const isActive = formData.get('is_active') != null;

  let rules: SyncRules;
  if (rules_mode === 'channels') {
    const channelIds = formData
      .getAll('channel_ids')
      .filter((value): value is string => typeof value === 'string');
    const rulesParsed = syncRulesSchema.safeParse({ mode: 'channels', channel_ids: channelIds });
    if (!rulesParsed.success) {
      redirect(
        integrationsUrl(orgId, { error: 'Bitte gültige Kanäle für die Sync-Regel auswählen.' })
      );
    }
    rules = rulesParsed.data;
  } else if (rules_mode === 'all') {
    rules = { mode: 'all' };
  } else {
    rules = { mode: 'manual' };
  }

  const supabase = await createSupabaseServerClient();
  const { data: existing } = await supabase
    .from('integrations')
    .select('config')
    .eq('org_id', orgId)
    .eq('type', 'hubspot')
    .maybeSingle();
  if (!existing) {
    redirect(integrationsUrl(orgId, { error: 'HubSpot ist nicht verbunden.' }));
  }
  const currentConfig = (existing.config ?? {}) as Record<string, unknown>;

  // spread keeps token_encrypted / ui_domain / portal_id intact
  const newConfig: Record<string, unknown> = {
    ...currentConfig,
    pipeline_id:
      pipeline_id !== ''
        ? pipeline_id
        : typeof currentConfig.pipeline_id === 'string'
          ? currentConfig.pipeline_id
          : '',
    default_stage_id:
      default_stage_id !== ''
        ? default_stage_id
        : typeof currentConfig.default_stage_id === 'string'
          ? currentConfig.default_stage_id
          : '',
  };
  if (resolved_stage_id !== '') {
    newConfig.resolved_stage_id = resolved_stage_id;
  } else {
    delete newConfig.resolved_stage_id;
  }

  const { data, error } = await supabase
    .from('integrations')
    .update({ config: newConfig, rules, is_active: isActive })
    .eq('org_id', orgId)
    .eq('type', 'hubspot')
    .select('org_id');
  if (error || !data || data.length === 0) {
    redirect(
      integrationsUrl(orgId, { error: 'Die Einstellungen konnten nicht gespeichert werden.' })
    );
  }

  revalidatePath('/settings/integrations');
  redirect(integrationsUrl(orgId, { notice: 'HubSpot-Einstellungen gespeichert.' }));
}

// --- disconnect --------------------------------------------------------------

const disconnectSchema = z.object({ org: z.uuid() });

/** Removes the integration row entirely — deletes the encrypted token with it. */
export async function disconnectHubspot(formData: FormData): Promise<void> {
  const org = textField(formData.get('org'));
  const parsed = disconnectSchema.safeParse({ org });
  if (!parsed.success) {
    redirect(integrationsUrl(org, { error: 'Verbindung konnte nicht getrennt werden.' }));
  }
  const { org: orgId } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('integrations')
    .delete()
    .eq('org_id', orgId)
    .eq('type', 'hubspot');
  if (error) {
    redirect(integrationsUrl(orgId, { error: 'Verbindung konnte nicht getrennt werden.' }));
  }

  revalidatePath('/settings/integrations');
  redirect(integrationsUrl(orgId, { notice: 'HubSpot-Verbindung getrennt.' }));
}
