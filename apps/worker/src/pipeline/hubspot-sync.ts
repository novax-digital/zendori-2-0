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
import { getServiceClient, isMissingColumnError } from '../db.js';

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
  company: string | null;
}

interface LoadedInboundMessage {
  id: string;
  content: string;
  content_type: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

/** One voice transcript turn (caller or assistant) for the ticket body/notes. */
interface TranscriptTurn {
  content: string;
  created_at: string;
  sender_type: string;
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
    company: contact.company,
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
    const created = await createTicketForConversation(
      supabase,
      hubspotConfig,
      conv,
      cfg,
      contactRef.id,
      syncStartedAt
    );
    ticketId = created.id;
    externalRefs.hubspot_ticket_id = ticketId;
    // Everything in the ticket body is covered by the watermark, so
    // noteFollowups posts only what arrived afterwards. Text channels: the
    // first inbound message; voice: the complete transcript (owner request
    // 2026-07-28 — the call IS the conversation, the first caller turn alone
    // is useless in HubSpot).
    externalRefs.hubspot_noted_through = created.notedThrough;
    await persistExternalRefs(supabase, conv, externalRefs);
  } else {
    ticketId = existing.id;
    externalRefs.hubspot_ticket_id = ticketId;
    // Reflect a resolved conversation as the configured resolved stage.
    if (conv.status === 'resolved' && cfg.resolved_stage_id) {
      await updateTicketStage(hubspotConfig, ticketId, cfg.resolved_stage_id);
    }
  }

  // Inbound customer messages after the watermark become notes. The watermark
  // is advanced + persisted after each successful note, so a retry after a
  // mid-batch failure resumes from the last PERSISTED note (at-least-once: the
  // one note whose persist failed can be re-posted). The ticket's createdAt is
  // the last-resort boundary for tickets whose watermark was never persisted
  // (crash between createTicket and persistExternalRefs).
  await noteFollowups(supabase, hubspotConfig, conv, ticketId, externalRefs, existing?.createdAt ?? null);

  // --- persist external ref + synced stamp (scheduling) -----------------------
  await finishSync(supabase, conv, externalRefs, syncStartedAt);
  await touchIntegrationSync(supabase, integration.id);

  // Status 'An HubSpot gesendet' (0026): the ticket is worked in HubSpot from
  // here on, so the conversation must not sit in the §6 'pending' queue. Set on
  // every SUCCESSFUL sync — manual button and automatic rules end up here alike.
  // 'resolved' is never overwritten (a closed case stays closed). Best-effort:
  // pre-0026 the CHECK constraint rejects the value, and a failed status flip
  // must not fail (and pg-boss-retry) an otherwise completed sync.
  try {
    await supabase
      .from('conversations')
      .update({ status: 'hubspot_sent' })
      .eq('id', conv.id)
      .eq('org_id', conv.org_id)
      .in('status', ['open', 'pending']);
  } catch {
    // schema skew or transient error — the sync itself succeeded
  }
}

/**
 * Post a note for every inbound customer message (voice: every transcript turn,
 * both sides) after the persisted watermark (external_refs.hubspot_noted_through),
 * advancing + persisting the watermark after each successful note. A pg-boss
 * retry resumes from the last PERSISTED watermark — at-least-once, so the one
 * note whose persist failed can be duplicated. Boundary fallbacks: the last
 * sync stamp (legacy tickets), then the ticket's HubSpot createdAt (watermark
 * never persisted because the first sync crashed right after createTicket).
 */
async function noteFollowups(
  supabase: SupabaseClient,
  hubspotConfig: HubSpotConfig,
  conv: LoadedConversationRow,
  ticketId: string,
  externalRefs: Record<string, unknown>,
  ticketCreatedAt: string | null
): Promise<void> {
  const watermark = externalRefs.hubspot_noted_through;
  const boundary =
    (typeof watermark === 'string' && watermark.length > 0 ? watermark : null) ??
    conv.hubspot_synced_at ??
    ticketCreatedAt;
  if (!boundary) return; // no first message yet — nothing to note

  if (conv.channel.type === 'voice') {
    // Voice: notes carry BOTH sides (labeled) so a ticket synced mid-call still
    // ends up with the complete transcript after the post-call sync. Pending
    // turns are batched into ONE note per size cap (readable in HubSpot, fewer
    // API calls); the watermark is persisted after each posted note, so a retry
    // resumes at-least-once from the last persisted batch.
    const turns = await loadTranscriptTurns(supabase, conv.id, boundary);
    let batch: TranscriptTurn[] = [];
    let batchLength = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      await attachNote(hubspotConfig, ticketId, {
        body: batch.map(formatVoiceTurn).join('\n'),
        sourceChannel: conv.channel.type,
        occurredAt: batch[0]!.created_at,
      });
      externalRefs.hubspot_noted_through = batch[batch.length - 1]!.created_at;
      await persistExternalRefs(supabase, conv, externalRefs);
      batch = [];
      batchLength = 0;
    };
    for (const turn of turns) {
      const lineLength = formatVoiceTurn(turn).length + 1;
      if (batch.length > 0 && batchLength + lineLength > VOICE_TRANSCRIPT_MAX_CHARS) {
        await flush();
      }
      batch.push(turn);
      batchLength += lineLength;
    }
    await flush();
    return;
  }

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
  syncStartedAt: string
): Promise<{ id: string; notedThrough: string | null }> {
  let content: string;
  let notedThrough: string | null;
  if (conv.channel.type === 'voice') {
    // Voice: the ticket body is the COMPLETE call transcript (caller +
    // assistant turns) — see the watermark comment at the call site.
    const turns = await loadTranscriptTurns(supabase, conv.id);
    const transcript = buildVoiceTranscriptBody(turns);
    content = buildTicketContent({
      body: transcript.body,
      attachments: [],
      channelName: conv.channel.name,
      receivedAt: turns[0]?.created_at ?? syncStartedAt,
    });
    // Watermark = last turn actually IN the body; turns cut by the size cap
    // are delivered as notes by noteFollowups right after.
    notedThrough = transcript.notedThrough;
  } else {
    const firstMessage = await loadFirstInboundMessage(supabase, conv.id);
    const attachments = firstMessage ? await loadAttachments(supabase, firstMessage.id) : [];
    const body = firstMessage
      ? cleanMessageBody(conv.channel.type, firstMessage.content, firstMessage.metadata)
      : '(kein Text)';
    content = buildTicketContent({
      body,
      attachments,
      channelName: conv.channel.name,
      receivedAt: firstMessage?.created_at ?? syncStartedAt,
    });
    notedThrough = firstMessage?.created_at ?? null;
  }
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
  return { id: created.id, notedThrough };
}

// HubSpot's note body cap is 65536; keep the ticket body safely below it too.
const VOICE_TRANSCRIPT_MAX_CHARS = 60_000;

/** "Anrufer:"/"Assistent:" lines — same labeling as the post-call AI transcript. */
export function formatVoiceTurn(turn: TranscriptTurn): string {
  return `${turn.sender_type === 'contact' ? 'Anrufer' : 'Assistent'}: ${turn.content}`;
}

/**
 * The call transcript as the voice ticket body, assembled turn-by-turn so the
 * size cap and the note watermark agree: `notedThrough` is the created_at of
 * the last turn FULLY included — turns cut by the cap stay after the watermark
 * and reach HubSpot as notes instead of being silently dropped.
 */
export function buildVoiceTranscriptBody(turns: TranscriptTurn[]): {
  body: string;
  notedThrough: string | null;
} {
  if (turns.length === 0) return { body: '(kein Transkript)', notedThrough: null };
  const lines: string[] = [];
  let length = 0;
  let included = 0;
  for (const turn of turns) {
    const line = formatVoiceTurn(turn);
    const extra = (lines.length > 0 ? 1 : 0) + line.length;
    if (length + extra > VOICE_TRANSCRIPT_MAX_CHARS) break;
    lines.push(line);
    length += extra;
    included += 1;
  }
  if (included === 0) {
    // A single turn longer than the whole cap: include it sliced — the body
    // must never regress to empty (the note cap would cut it anyway).
    return {
      body: formatVoiceTurn(turns[0]!).slice(0, VOICE_TRANSCRIPT_MAX_CHARS),
      notedThrough: turns[0]!.created_at,
    };
  }
  const truncated = included < turns.length;
  return {
    body: lines.join('\n') + (truncated ? '\n(Transkript gekürzt — Fortsetzung als Notiz)' : ''),
    notedThrough: turns[included - 1]!.created_at,
  };
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
  let { data, error } = await supabase
    .from('contacts')
    .select('name, email, phone, company')
    .eq('id', contactId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error && isMissingColumnError(error)) {
    // contacts.company not migrated yet (worker ahead of 0027) — retry without.
    ({ data, error } = await supabase
      .from('contacts')
      .select('name, email, phone')
      .eq('id', contactId)
      .eq('org_id', orgId)
      .maybeSingle());
  }
  if (error) throw error;
  return data ? ({ company: null, ...(data as object) } as LoadedContact) : null;
}

/**
 * Voice transcript turns (caller + assistant) in chronological order — the
 * source for the voice ticket body and the labeled follow-up notes. System
 * messages ("Ticket aufgenommen", "Anruf beendet") stay internal.
 */
async function loadTranscriptTurns(
  supabase: SupabaseClient,
  conversationId: string,
  sinceIso?: string
): Promise<TranscriptTurn[]> {
  let query = supabase
    .from('messages')
    .select('content, created_at, sender_type')
    .eq('conversation_id', conversationId)
    .or('and(direction.eq.in,sender_type.eq.contact),and(direction.eq.out,sender_type.eq.bot)');
  if (sinceIso) query = query.gt('created_at', sinceIso);
  const { data, error } = await query.order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as TranscriptTurn[];
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
