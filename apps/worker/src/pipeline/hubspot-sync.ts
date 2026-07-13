// One-way HubSpot ticket sync (CLAUDE.md §11 Phase 6, docs/legacy-analysis.md
// §2.7). Runs in the worker off the pg-boss 'hubspot.sync-conversation' queue,
// driven by the scan's "due" predicate on conversations.hubspot_sync_requested_at
// / hubspot_synced_at (migration 0007). syncConversation is idempotent per the
// zendori_ref = conversation UUID anchor: it upserts the contact, then reads the
// ticket by ref (create if absent, else update stage + attach follow-up notes),
// stores external_refs.hubspot_ticket_id and stamps hubspot_synced_at.
//
// Never logs ticket/message content or the decrypted token (§7). The token lives
// encrypted in integrations.config.token_encrypted and is only decrypted
// transiently here for the Authorization header inside the HubSpot client.
import { z } from 'zod';
import {
  createLogger,
  decryptSecret,
  loadWorkerEnv,
  type ChannelType,
  type ConversationPriority,
  type ConversationStatus,
  type SupabaseClient,
} from '@zendori/core';
import {
  attachNote,
  createTicket,
  findTicketByRef,
  updateTicketStage,
  upsertContact,
  type HubSpotConfig,
  type TicketDraft,
} from '@zendori/integrations';
import { getServiceClient } from '../db.js';

const logger = createLogger('worker.hubspot-sync');

/** Shape of integrations.config for a HubSpot integration (§ contract Config-Formen). */
const hubspotIntegrationConfigSchema = z.object({
  token_encrypted: z.string().min(1),
  pipeline_id: z.string().min(1),
  default_stage_id: z.string().min(1),
  resolved_stage_id: z.string().min(1).optional(),
});

// --- loaded row shapes (DB boundary, cast via `as unknown as`) ----------------

interface LoadedChannel {
  id: string;
  type: ChannelType;
  name: string;
}

interface LoadedConversationRow {
  id: string;
  org_id: string;
  channel_id: string;
  contact_id: string | null;
  subject: string | null;
  status: ConversationStatus;
  priority: ConversationPriority;
  external_refs: Record<string, unknown>;
  hubspot_synced_at: string | null;
  channel: LoadedChannel;
}

interface LoadedContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

interface LoadedInboundMessage {
  id: string;
  content: string;
  content_type: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

interface LoadedAttachment {
  storage_path: string;
  mime: string;
}

const CONVERSATION_SELECT =
  'id, org_id, channel_id, contact_id, subject, status, priority, external_refs, hubspot_synced_at, ' +
  'channel:channels!inner(id, type, name)';

/**
 * Sync one conversation to HubSpot. Idempotent via zendori_ref (conversation
 * UUID). Throws on any HubSpot/DB error so pg-boss retries; the queue handler
 * marks the sync terminal (hubspot_synced_at=now) once retries are exhausted so
 * the scan stops re-picking it — a later request bumps requested_at and re-arms.
 *
 * hubspot_synced_at is stamped with the timestamp captured at the START of the
 * sync, not the end: a re-request that arrives mid-sync (requested_at > start)
 * stays "due" and is re-picked, so no update is ever lost (0007 design note).
 */
export async function syncConversation(conversationId: string): Promise<void> {
  const supabase = getServiceClient();
  const syncStartedAt = new Date().toISOString();

  const { data: convData, error: convError } = await supabase
    .from('conversations')
    .select(CONVERSATION_SELECT)
    .eq('id', conversationId)
    .maybeSingle();
  if (convError) throw convError;
  if (!convData) return; // conversation vanished — nothing to sync
  const conv = convData as unknown as LoadedConversationRow;
  const orgId = conv.org_id;

  // --- active HubSpot integration (unique per org, type=hubspot) --------------
  const { data: integrationData, error: integrationError } = await supabase
    .from('integrations')
    .select('id, config')
    .eq('org_id', orgId)
    .eq('type', 'hubspot')
    .eq('is_active', true)
    .maybeSingle();
  if (integrationError) throw integrationError;
  if (!integrationData) {
    // No active integration: nothing to do — stamp synced so the scan stops.
    await stampSynced(supabase, conversationId, orgId, syncStartedAt);
    return;
  }
  const integration = integrationData as { id: string; config: unknown };

  const parsedConfig = hubspotIntegrationConfigSchema.safeParse(integration.config);
  if (!parsedConfig.success) {
    // Permanent misconfiguration (missing pipeline/stage/token): retrying cannot
    // help, so stamp synced to stop the scan instead of spinning pg-boss retries.
    logger.warn({ conversationId }, 'hubspot integration config invalid — skipping sync');
    await stampSynced(supabase, conversationId, orgId, syncStartedAt);
    return;
  }
  const cfg = parsedConfig.data;

  const masterKey = loadWorkerEnv().MASTER_ENCRYPTION_KEY;
  if (!masterKey) {
    throw new Error('MASTER_ENCRYPTION_KEY is not set — cannot decrypt HubSpot token');
  }
  const token = await decryptSecret(cfg.token_encrypted, masterKey);
  // HUBSPOT_API_BASE overrides the default api.hubapi.com — only for local
  // testing against a stub; unset in production.
  const baseUrl = process.env.HUBSPOT_API_BASE?.trim();
  const hubspotConfig: HubSpotConfig = baseUrl ? { token, baseUrl } : { token };

  // --- contact ----------------------------------------------------------------
  const contact = conv.contact_id ? await loadContact(supabase, conv.contact_id, orgId) : null;
  if (!contact || (!contact.email && !contact.phone)) {
    // A HubSpot ticket needs a contact association; without an email or phone we
    // cannot upsert one. Stamp synced so the scan stops; a later contact
    // correction + new request re-arms the sync.
    logger.warn({ conversationId }, 'conversation has no contact channel — skipping hubspot sync');
    await stampSynced(supabase, conversationId, orgId, syncStartedAt);
    return;
  }
  const contactRef = await upsertContact(hubspotConfig, {
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
  });

  // --- ticket: create (new) or update (existing) ------------------------------
  // external_refs carries the HubSpot ticket id AND a dedicated note watermark
  // (hubspot_noted_through = created_at of the last message put into the ticket,
  // as body or note). The watermark is separate from hubspot_synced_at (which is
  // the sync-start stamp used only for scheduling), so notes are never double-
  // posted on a mid-sync arrival or a pg-boss retry.
  const externalRefs: Record<string, unknown> = { ...(conv.external_refs ?? {}) };
  const existing = await findTicketByRef(hubspotConfig, conversationId);

  let ticketId: string;
  if (!existing) {
    const firstMessage = await loadFirstInboundMessage(supabase, conversationId);
    ticketId = await createTicketForConversation(
      supabase,
      hubspotConfig,
      conv,
      cfg,
      contactRef.id,
      firstMessage,
      syncStartedAt
    );
    externalRefs.hubspot_ticket_id = ticketId;
    // The first message went into the ticket body; seed the watermark to it so
    // noteFollowups posts only the follow-ups (#2..N) that already exist.
    externalRefs.hubspot_noted_through = firstMessage?.created_at ?? null;
    await persistExternalRefs(supabase, conv, externalRefs);
  } else {
    ticketId = existing.id;
    externalRefs.hubspot_ticket_id = ticketId;
    // Reflect a resolved conversation as the configured resolved stage.
    if (conv.status === 'resolved' && cfg.resolved_stage_id) {
      await updateTicketStage(hubspotConfig, ticketId, cfg.resolved_stage_id);
    }
  }

  // Inbound customer messages after the watermark become notes (at-most-once:
  // the watermark is advanced + persisted after each successful note, so a retry
  // after a mid-batch failure resumes without re-posting earlier notes).
  await noteFollowups(supabase, hubspotConfig, conv, ticketId, externalRefs);

  // --- persist external ref + synced stamp (scheduling) -----------------------
  await finishSync(supabase, conv, externalRefs, syncStartedAt);
  await touchIntegrationSync(supabase, integration.id);
}

/**
 * Post a note for every inbound customer message after the persisted watermark
 * (external_refs.hubspot_noted_through), advancing + persisting the watermark
 * after each successful note so a pg-boss retry never re-posts an already-noted
 * message. Falls back to the last sync stamp for tickets created before the
 * watermark existed.
 */
async function noteFollowups(
  supabase: SupabaseClient,
  hubspotConfig: HubSpotConfig,
  conv: LoadedConversationRow,
  ticketId: string,
  externalRefs: Record<string, unknown>
): Promise<void> {
  const watermark = externalRefs.hubspot_noted_through;
  const boundary =
    typeof watermark === 'string' && watermark.length > 0 ? watermark : conv.hubspot_synced_at;
  if (!boundary) return; // no first message yet — nothing to note

  const messages = await loadInboundSince(supabase, conv.id, boundary);
  for (const message of messages) {
    await attachNote(hubspotConfig, ticketId, {
      body: cleanMessageBody(conv.channel.type, message.content, message.metadata),
      sourceChannel: conv.channel.type,
      occurredAt: message.created_at,
    });
    externalRefs.hubspot_noted_through = message.created_at;
    await persistExternalRefs(supabase, conv, externalRefs);
  }
}

/**
 * Terminal-failure handler (called by the queue handler once retries are
 * exhausted): stamp hubspot_synced_at=now so the scan stops re-picking the
 * conversation. A later request (requested_at bump) re-arms it. Never throws.
 */
export async function markHubspotSyncTerminal(conversationId: string): Promise<void> {
  try {
    const supabase = getServiceClient();
    await supabase
      .from('conversations')
      .update({ hubspot_synced_at: new Date().toISOString() })
      .eq('id', conversationId);
  } catch {
    // best-effort: never throw from the terminal handler
  }
}

// --- helpers -----------------------------------------------------------------

async function createTicketForConversation(
  supabase: SupabaseClient,
  hubspotConfig: HubSpotConfig,
  conv: LoadedConversationRow,
  cfg: z.infer<typeof hubspotIntegrationConfigSchema>,
  contactId: string,
  firstMessage: LoadedInboundMessage | null,
  syncStartedAt: string
): Promise<string> {
  const attachments = firstMessage ? await loadAttachments(supabase, firstMessage.id) : [];
  const body = firstMessage
    ? cleanMessageBody(conv.channel.type, firstMessage.content, firstMessage.metadata)
    : '(kein Text)';
  const content = buildTicketContent({
    body,
    attachments,
    channelName: conv.channel.name,
    receivedAt: firstMessage?.created_at ?? syncStartedAt,
  });
  // A conversation already resolved at first sync (e.g. rule=manual, agent
  // resolves then the closing sync creates the ticket) is created directly in
  // the resolved stage instead of the open default stage.
  const stageId =
    conv.status === 'resolved' && cfg.resolved_stage_id
      ? cfg.resolved_stage_id
      : cfg.default_stage_id;
  const draft: TicketDraft = {
    subject: conv.subject ?? 'Konversation',
    content,
    priority: conv.priority,
    pipelineId: cfg.pipeline_id,
    stageId,
    sourceChannel: conv.channel.type,
    ref: conv.id,
  };
  const created = await createTicket(hubspotConfig, draft, contactId);
  return created.id;
}

/**
 * Assemble the HubSpot ticket body (docs/legacy-analysis.md §2.7 buildTicketContent):
 * cleaned inbound message, an optional attachments hint, and a channel/received
 * footer.
 */
export function buildTicketContent(input: {
  body: string;
  attachments: LoadedAttachment[];
  channelName: string;
  receivedAt: string;
}): string {
  const parts: string[] = [input.body];
  if (input.attachments.length > 0) {
    parts.push(
      '',
      `Anhänge (${input.attachments.length}, abrufbar im Zendori-Dashboard):`,
      ...input.attachments.map((a) => `- ${basename(a.storage_path)} (${a.mime})`)
    );
  }
  parts.push('', `— Eingang über Kanal "${input.channelName}" am ${input.receivedAt}`);
  return parts.join('\n');
}

function basename(path: string): string {
  const segments = path.split('/');
  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : path;
}

/**
 * Text used for the ticket body / notes. For email prefer the reply-stripped
 * variant kept in metadata.email.stripped (Phase 3), else the full content.
 */
function cleanMessageBody(
  channelType: ChannelType,
  content: string,
  metadata: Record<string, unknown>
): string {
  if (channelType === 'email') {
    const stripped = readEmailStripped(metadata);
    if (stripped && stripped.trim().length > 0) return stripped;
  }
  return content;
}

function readEmailStripped(metadata: Record<string, unknown>): string | null {
  const email = metadata.email;
  if (email && typeof email === 'object' && !Array.isArray(email)) {
    const stripped = (email as Record<string, unknown>).stripped;
    if (typeof stripped === 'string') return stripped;
  }
  return null;
}

async function loadContact(
  supabase: SupabaseClient,
  contactId: string,
  orgId: string
): Promise<LoadedContact | null> {
  // org-scoped like every write path: the worker bypasses RLS, so the tenant
  // filter is explicit rather than relying on referential integrity.
  const { data, error } = await supabase
    .from('contacts')
    .select('name, email, phone')
    .eq('id', contactId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw error;
  return data ? (data as unknown as LoadedContact) : null;
}

async function loadFirstInboundMessage(
  supabase: SupabaseClient,
  conversationId: string
): Promise<LoadedInboundMessage | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, content, content_type, created_at, metadata')
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .eq('sender_type', 'contact')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? (data as unknown as LoadedInboundMessage) : null;
}

/** Inbound customer messages received strictly after `sinceIso` (last sync). */
async function loadInboundSince(
  supabase: SupabaseClient,
  conversationId: string,
  sinceIso: string
): Promise<LoadedInboundMessage[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, content, content_type, created_at, metadata')
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .eq('sender_type', 'contact')
    .gt('created_at', sinceIso)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as LoadedInboundMessage[];
}

async function loadAttachments(
  supabase: SupabaseClient,
  messageId: string
): Promise<LoadedAttachment[]> {
  const { data, error } = await supabase
    .from('attachments')
    .select('storage_path, mime')
    .eq('message_id', messageId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as LoadedAttachment[];
}

/** Persist the external_refs (ticket id + note watermark) mid-sync. */
async function persistExternalRefs(
  supabase: SupabaseClient,
  conv: LoadedConversationRow,
  externalRefs: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from('conversations')
    .update({ external_refs: externalRefs })
    .eq('id', conv.id)
    .eq('org_id', conv.org_id);
  if (error) throw error;
}

/** Persist the final external_refs and stamp hubspot_synced_at (scheduling). */
async function finishSync(
  supabase: SupabaseClient,
  conv: LoadedConversationRow,
  externalRefs: Record<string, unknown>,
  syncedAt: string
): Promise<void> {
  const { error } = await supabase
    .from('conversations')
    .update({ external_refs: externalRefs, hubspot_synced_at: syncedAt })
    .eq('id', conv.id)
    .eq('org_id', conv.org_id);
  if (error) throw error;
}

/** Stamp hubspot_synced_at only (no-op sync paths: no integration / no contact). */
async function stampSynced(
  supabase: SupabaseClient,
  conversationId: string,
  orgId: string,
  syncedAt: string
): Promise<void> {
  const { error } = await supabase
    .from('conversations')
    .update({ hubspot_synced_at: syncedAt })
    .eq('id', conversationId)
    .eq('org_id', orgId);
  if (error) throw error;
}

async function touchIntegrationSync(
  supabase: SupabaseClient,
  integrationId: string
): Promise<void> {
  const { error } = await supabase
    .from('integrations')
    .update({ last_sync_at: new Date().toISOString() })
    .eq('id', integrationId);
  if (error) throw error;
}
