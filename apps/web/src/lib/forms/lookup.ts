import 'server-only';
import { formDefinitionSchema, type FormDefinition } from '@zendori/channels';
import type { SupabaseClient } from '@zendori/core';

// Service-role lookups for the public form endpoints (bootstrap/submit).
// Mirrors the widget's WidgetDbError contract: "not found" and "db down" must
// answer differently (404 vs 503), so a transient outage never looks like an
// unknown token to the embed.

export class FormDbError extends Error {
  constructor(context: string) {
    super(`Form DB query failed: ${context}`);
    this.name = 'FormDbError';
  }
}

export interface ActiveForm {
  id: string;
  orgId: string;
  channelId: string;
  name: string;
  definition: FormDefinition;
  version: number;
  notificationEmails: string[];
  dailySubmissionLimit: number;
}

/**
 * Resolves a public form token to its active form + active channel.
 * Returns null for unknown tokens, inactive forms/channels or invalid
 * definitions; throws FormDbError on database errors.
 */
export async function findActiveFormByToken(
  admin: SupabaseClient,
  token: string
): Promise<ActiveForm | null> {
  const { data, error } = await admin
    .from('forms')
    .select('id, org_id, channel_id, name, definition, version, notification_emails, daily_submission_limit, is_active')
    .eq('public_token', token)
    .limit(1);
  if (error) {
    // pre-migration deploys: the table does not exist yet → behave like 404
    if ((error as { code?: string }).code === '42P01') return null;
    throw new FormDbError('forms lookup');
  }
  const row = (data ?? [])[0] as
    | {
        id: string;
        org_id: string;
        channel_id: string;
        name: string;
        definition: unknown;
        version: number;
        notification_emails: unknown;
        daily_submission_limit: number;
        is_active: boolean;
      }
    | undefined;
  if (!row || !row.is_active) return null;

  const { data: channelRow, error: channelError } = await admin
    .from('channels')
    .select('is_active')
    .eq('id', row.channel_id)
    .eq('org_id', row.org_id)
    .maybeSingle();
  if (channelError) throw new FormDbError('channels lookup');
  if (!(channelRow as { is_active: boolean } | null)?.is_active) return null;

  const definition = formDefinitionSchema.safeParse(row.definition);
  if (!definition.success) return null;

  const emails = Array.isArray(row.notification_emails)
    ? row.notification_emails.filter((e): e is string => typeof e === 'string')
    : [];

  return {
    id: row.id,
    orgId: row.org_id,
    channelId: row.channel_id,
    name: row.name,
    definition: definition.data,
    version: row.version,
    notificationEmails: emails,
    dailySubmissionLimit: row.daily_submission_limit,
  };
}
