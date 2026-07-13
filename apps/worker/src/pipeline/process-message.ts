// Full Phase-4 inbound message pipeline (CLAUDE.md §4/§11). Runs in the worker
// off the pg-boss queue: classify → (extract + contact correction for
// email/form) → retrieve (RAG) → draft → persist a pending ai_draft. No
// auto-send, no handoff (Phase 5). Message content is never logged (§7); the
// classification/extraction summaries stored in the DB are PII-free by prompt
// design and live in RLS-protected tables, not in logs.
import {
  AI_MODELS,
  EMBEDDING_MODEL,
  classify,
  draft,
  embed,
  extract,
  type AiRunStep,
  type ClassificationResult,
  type KbChunkMatch,
} from '@zendori/ai';
import type {
  ChannelType,
  ContentType,
  ConversationMode,
  ConversationPriority,
  MessageDirection,
  ProcessingState,
  SenderType,
  SupabaseClient,
} from '@zendori/core';
import { getServiceClient } from '../db.js';

/**
 * Default ticket categories (docs/legacy-analysis.md §2.4). v2 has no per-org
 * category list yet; the last entry is the catch-all category.
 */
const DEFAULT_CATEGORIES = ['Frage', 'Störung', 'Reklamation', 'Bestellung', 'Sonstiges'] as const;

/** Max characters of a chunk kept as a provenance snippet in ai_drafts.sources. */
const SNIPPET_MAX_CHARS = 200;

/**
 * Character cap for the embedding query. OpenAI rejects inputs over ~8192 tokens
 * with HTTP 400, which would fail the retrieve step on every retry and stall the
 * pipeline permanently. ~24k chars stays well under that (token-safety margin).
 */
const MAX_EMBED_QUERY_CHARS = 24_000;

// --- loaded row shapes (DB boundary, cast via `as unknown as`) ----------------

interface LoadedConversation {
  id: string;
  org_id: string;
  mode: ConversationMode;
  priority: ConversationPriority;
  contact_id: string | null;
  subject: string | null;
}

interface LoadedChannel {
  id: string;
  type: ChannelType;
  name: string;
}

interface LoadedMessage {
  id: string;
  org_id: string;
  conversation_id: string;
  channel_id: string;
  direction: MessageDirection;
  sender_type: SenderType;
  content: string;
  content_type: ContentType;
  metadata: Record<string, unknown>;
  processing_state: ProcessingState | null;
  conversation: LoadedConversation;
  channel: LoadedChannel;
}

interface LoadedContact {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

interface ExtractedContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

interface DraftSourceEntry {
  source_id: string;
  uri: string | null;
  snippet: string;
}

/**
 * Error carrying the failing pipeline step + ids so the queue handler can log a
 * precise ai_runs entry when retries are exhausted.
 */
export class PipelineError extends Error {
  constructor(
    public readonly step: AiRunStep,
    public readonly orgId: string,
    public readonly conversationId: string,
    cause: unknown
  ) {
    super(`pipeline step '${step}' failed`, { cause });
    this.name = 'PipelineError';
  }
}

const MESSAGE_SELECT =
  'id, org_id, conversation_id, channel_id, direction, sender_type, content, content_type, metadata, processing_state, ' +
  'conversation:conversations!inner(id, org_id, mode, priority, contact_id, subject), ' +
  'channel:channels!inner(id, type, name)';

/**
 * Process one inbound message. Idempotent: guards short-circuit anything that is
 * not a pending inbound customer message on a bot-mode conversation. Throws on
 * any step error so pg-boss retries; the queue handler marks the message
 * `skipped` + logs the failure once retries are exhausted.
 */
export async function processMessage(messageId: string): Promise<void> {
  const supabase = getServiceClient();

  const { data: messageData, error: loadError } = await supabase
    .from('messages')
    .select(MESSAGE_SELECT)
    .eq('id', messageId)
    .maybeSingle();
  if (loadError) throw loadError;
  if (!messageData) return; // message vanished — nothing to do

  const message = messageData as unknown as LoadedMessage;
  const conv = message.conversation;
  const channel = message.channel;

  // Guards. Outbound messages must never carry a processing_state (DB
  // constraint messages_processing_state_only_inbound), so only ever write it
  // on inbound rows.
  if (message.direction !== 'in') return;
  if (message.processing_state !== 'pending') return; // already handled (idempotent)
  if (message.sender_type !== 'contact') {
    await markDone(supabase, message.id);
    return;
  }
  if (conv.mode !== 'bot') {
    await markDone(supabase, message.id);
    return;
  }

  const orgId = message.org_id;
  const updatedMetadata: Record<string, unknown> = { ...message.metadata };
  let currentStep: AiRunStep = 'classify';

  try {
    // --- context loads -------------------------------------------------------
    const [orgName, toneInstructions, currentContact] = await Promise.all([
      loadOrgName(supabase, orgId),
      loadToneInstructions(supabase, orgId),
      conv.contact_id ? loadContact(supabase, conv.contact_id) : Promise.resolve(null),
    ]);

    const cleanBody = deriveCleanBody(channel.type, message);
    const inputSummary = `channel=${channel.type} chars=${cleanBody.length}`;

    // --- 1. classify ---------------------------------------------------------
    currentStep = 'classify';
    const classifyStart = Date.now();
    const { result: classification, costUsd: classifyCost } = await classify({
      companyName: orgName,
      toneInstructions,
      channelType: channel.type,
      subject: conv.subject,
      body: cleanBody,
    });
    const classifyLatency = Date.now() - classifyStart;
    updatedMetadata.classification = classification;

    // Spam / auto-reply: skip the draft path entirely.
    if (classification.is_spam || classification.is_auto_reply) {
      await supabase
        .from('messages')
        .update({ processing_state: 'skipped', metadata: updatedMetadata })
        .eq('id', message.id);
      await logAiRun(supabase, {
        orgId,
        conversationId: conv.id,
        step: 'classify',
        model: AI_MODELS.classify,
        latencyMs: classifyLatency,
        costUsd: classifyCost,
        inputSummary,
        outputSummary: summarizeClassification(classification),
      });
      return;
    }

    // Sync conversation priority only when the classification disagrees.
    if (classification.priority !== conv.priority) {
      const { error } = await supabase
        .from('conversations')
        .update({ priority: classification.priority })
        .eq('id', conv.id);
      if (error) throw error;
    }
    await logAiRun(supabase, {
      orgId,
      conversationId: conv.id,
      step: 'classify',
      model: AI_MODELS.classify,
      latencyMs: classifyLatency,
      costUsd: classifyCost,
      inputSummary,
      outputSummary: summarizeClassification(classification),
    });

    // --- 2. extract (email or form-like bodies only) -------------------------
    if (channel.type === 'email' || looksLikeForm(cleanBody)) {
      currentStep = 'extract';
      const extractStart = Date.now();
      const { result: extraction, costUsd: extractCost } = await extract({
        companyName: orgName,
        categories: DEFAULT_CATEGORIES,
        toneInstructions,
        channelType: channel.type,
        subject: conv.subject,
        body: cleanBody,
      });
      const extractLatency = Date.now() - extractStart;
      updatedMetadata.extract = {
        subject: extraction.subject,
        category: extraction.category,
        missing_fields: extraction.missing_fields,
        questions: extraction.questions,
        confidence: extraction.confidence,
      };
      await correctContact(supabase, orgId, conv, currentContact, extraction.contact);
      await logAiRun(supabase, {
        orgId,
        conversationId: conv.id,
        step: 'extract',
        model: AI_MODELS.classify,
        confidence: extraction.confidence,
        latencyMs: extractLatency,
        costUsd: extractCost,
        inputSummary,
        outputSummary: `category=${extraction.category} missing=${extraction.missing_fields.length} questions=${extraction.questions.length}`,
      });
    }

    // --- 3. retrieve (RAG) ---------------------------------------------------
    currentStep = 'retrieve';
    const retrieveStart = Date.now();
    const { vectors, costUsd: embedCost } = await embed([
      cleanBody.slice(0, MAX_EMBED_QUERY_CHARS),
    ]);
    const queryVector = vectors[0];
    if (!queryVector) throw new Error('embedding returned no vector for the query');
    const { data: matchData, error: matchError } = await supabase.rpc('match_kb_chunks', {
      p_org_id: orgId,
      p_embedding: queryVector,
      p_match_threshold: 0.3,
      p_match_count: 6,
    });
    if (matchError) throw matchError;
    const matches = (matchData ?? []) as unknown as KbChunkMatch[];
    const retrieveLatency = Date.now() - retrieveStart;
    await logAiRun(supabase, {
      orgId,
      conversationId: conv.id,
      step: 'retrieve',
      model: EMBEDDING_MODEL,
      latencyMs: retrieveLatency,
      costUsd: embedCost,
      inputSummary,
      outputSummary: `matches=${matches.length}`,
    });

    // --- 4. draft (Sonnet) ---------------------------------------------------
    currentStep = 'draft';
    const draftStart = Date.now();
    const { result: draftResult, costUsd: draftCost } = await draft({
      companyName: orgName,
      toneInstructions,
      channelType: channel.type,
      subject: conv.subject,
      body: cleanBody,
      // Only pin the reply language for de/en; 'other' passes null so the draft
      // prompt falls back to "answer in the customer's language" instead of the
      // literal, unhelpful hint "answer in this language: other".
      language: draftLanguage(classification.language),
      sources: matches.map((match) => ({ sourceId: match.source_id, content: match.content })),
    });
    const draftLatency = Date.now() - draftStart;
    await logAiRun(supabase, {
      orgId,
      conversationId: conv.id,
      step: 'draft',
      model: AI_MODELS.draft,
      confidence: draftResult.confidence,
      latencyMs: draftLatency,
      costUsd: draftCost,
      inputSummary: `sources=${matches.length}`,
      outputSummary: `confidence=${draftResult.confidence.toFixed(2)} used=${draftResult.used_source_ids.length}`,
    });

    // --- 5. persist the draft ------------------------------------------------
    const draftSources = await buildDraftSources(supabase, matches, draftResult.used_source_ids);
    // Supersede the existing pending draft first (unique-index: max 1 pending
    // per conversation), then insert the fresh one.
    const supersede = await supabase
      .from('ai_drafts')
      .update({ status: 'discarded' })
      .eq('conversation_id', conv.id)
      .eq('status', 'pending');
    if (supersede.error) throw supersede.error;
    const insertDraft = await supabase.from('ai_drafts').insert({
      org_id: orgId,
      conversation_id: conv.id,
      message_id: message.id,
      content: draftResult.reply,
      confidence: draftResult.confidence,
      sources: draftSources,
      model: AI_MODELS.draft,
      status: 'pending',
    });
    if (insertDraft.error) throw insertDraft.error;

    // --- 6. done -------------------------------------------------------------
    const done = await supabase
      .from('messages')
      .update({ processing_state: 'done', metadata: updatedMetadata })
      .eq('id', message.id);
    if (done.error) throw done.error;
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(currentStep, orgId, conv.id, err);
  }
}

/**
 * Terminal-failure handler (called by the queue handler once retries are
 * exhausted): mark the inbound message `skipped` so the poller stops
 * re-enqueuing it, and record a best-effort ai_runs failure entry. Never throws.
 */
export async function handlePipelineFailure(messageId: string, err: unknown): Promise<void> {
  const supabase = getServiceClient();
  try {
    await supabase
      .from('messages')
      .update({ processing_state: 'skipped' })
      .eq('id', messageId)
      .eq('direction', 'in');
    if (err instanceof PipelineError) {
      await supabase.from('ai_runs').insert({
        org_id: err.orgId,
        conversation_id: err.conversationId,
        step: err.step,
        model: modelForStep(err.step),
        output_summary: 'pipeline_failed',
      });
    }
  } catch {
    // Best-effort: never throw from the failure handler.
  }
}

// --- helpers -----------------------------------------------------------------

function modelForStep(step: AiRunStep): string {
  if (step === 'draft') return AI_MODELS.draft;
  if (step === 'retrieve') return EMBEDDING_MODEL;
  return AI_MODELS.classify;
}

async function markDone(supabase: SupabaseClient, messageId: string): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .update({ processing_state: 'done' })
    .eq('id', messageId);
  if (error) throw error;
}

/**
 * Query text used for classification/extraction/retrieval. For email prefer the
 * reply-stripped variant kept in metadata.email.stripped (Phase 3), else the
 * full body.
 */
function deriveCleanBody(channelType: ChannelType, message: LoadedMessage): string {
  if (channelType === 'email') {
    const stripped = readEmailStripped(message.metadata);
    if (stripped && stripped.trim().length > 0) return stripped;
  }
  return message.content;
}

function readEmailStripped(metadata: Record<string, unknown>): string | null {
  const email = metadata.email;
  if (email && typeof email === 'object' && !Array.isArray(email)) {
    const stripped = (email as Record<string, unknown>).stripped;
    if (typeof stripped === 'string') return stripped;
  }
  return null;
}

/** Matches a `key: value` line (key ≤ 40 chars, value non-empty). Used to detect
 *  form-serialized bodies (payloadToBodyText output, legacy-analysis §2.6). */
const FORM_LINE = /^[^\n:]{1,40}:\s+\S/;

/** Heuristic: a body with ≥2 `key: value` lines looks like a serialized form. */
export function looksLikeForm(text: string): boolean {
  let keyValueLines = 0;
  for (const line of text.split('\n')) {
    if (FORM_LINE.test(line.trim())) {
      keyValueLines += 1;
      if (keyValueLines >= 2) return true;
    }
  }
  return false;
}

/** Draft language hint: pin de/en, leave 'other' unset for the prompt fallback. */
function draftLanguage(language: ClassificationResult['language']): 'de' | 'en' | null {
  return language === 'de' || language === 'en' ? language : null;
}

function summarizeClassification(c: ClassificationResult): string {
  return (
    `lang=${c.language} intent=${c.intent} priority=${c.priority} ` +
    `spam=${c.is_spam} auto_reply=${c.is_auto_reply} wants_human=${c.wants_human}`
  );
}

/**
 * Correct the conversation's contact from the extracted sender. When the
 * extracted email differs from the current contact, find-or-create a contact
 * by (org_id, lowercased email) and re-point the conversation; otherwise fill
 * only the empty name/phone gaps.
 */
async function correctContact(
  supabase: SupabaseClient,
  orgId: string,
  conv: LoadedConversation,
  currentContact: LoadedContact | null,
  extracted: ExtractedContact
): Promise<void> {
  const email = extracted.email?.trim().toLowerCase();
  if (!email || email.length === 0) return; // no reliable contact channel to correct to

  if (currentContact?.email && currentContact.email.toLowerCase() === email) {
    await fillContactGaps(supabase, currentContact, extracted);
    return;
  }

  const contactId = await findOrCreateContactByEmail(supabase, orgId, email, extracted);

  if (contactId !== conv.contact_id) {
    const { error } = await supabase
      .from('conversations')
      .update({ contact_id: contactId })
      .eq('id', conv.id);
    if (error) throw error;
  }
}

/**
 * Find-or-create a contact by (org_id, lower(email)). `email` must already be
 * lowercased. Insert-first, then re-select on a 23505 unique-violation: two
 * concurrent runs that both see "no contact" no longer create a duplicate — the
 * loser reuses the winner's row (backed by contacts_org_email_unique_idx).
 */
async function findOrCreateContactByEmail(
  supabase: SupabaseClient,
  orgId: string,
  email: string,
  extracted: ExtractedContact
): Promise<string> {
  const existing = await selectContactByEmail(supabase, orgId, email);
  if (existing) {
    await fillContactGaps(supabase, existing, extracted);
    return existing.id;
  }

  const { data: created, error: insertError } = await supabase
    .from('contacts')
    .insert({
      org_id: orgId,
      email,
      name: extracted.name ?? null,
      phone: extracted.phone ?? null,
    })
    .select('id')
    .single();
  if (!insertError && created) {
    return (created as unknown as { id: string }).id;
  }
  if (insertError && insertError.code === '23505') {
    // Lost the create race — the concurrent insert won; reuse its row.
    const raced = await selectContactByEmail(supabase, orgId, email);
    if (raced) {
      await fillContactGaps(supabase, raced, extracted);
      return raced.id;
    }
  }
  throw insertError ?? new Error('contact upsert returned no row');
}

async function selectContactByEmail(
  supabase: SupabaseClient,
  orgId: string,
  email: string
): Promise<LoadedContact | null> {
  const { data, error } = await supabase
    .from('contacts')
    .select('id, name, email, phone')
    .eq('org_id', orgId)
    .eq('email', email)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? (data as unknown as LoadedContact) : null;
}

async function fillContactGaps(
  supabase: SupabaseClient,
  contact: LoadedContact,
  extracted: ExtractedContact
): Promise<void> {
  const patch: Record<string, string> = {};
  const name = extracted.name?.trim();
  const phone = extracted.phone?.trim();
  if (!contact.name && name && name.length > 0) patch.name = name;
  if (!contact.phone && phone && phone.length > 0) patch.phone = phone;
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase.from('contacts').update(patch).eq('id', contact.id);
  if (error) throw error;
}

/**
 * Build the ai_drafts.sources provenance list: the sources actually used by the
 * draft (falling back to the top 3 retrieved when the model named none),
 * de-duplicated, each with its kb_source uri and a short content snippet.
 */
async function buildDraftSources(
  supabase: SupabaseClient,
  matches: KbChunkMatch[],
  usedSourceIds: string[]
): Promise<DraftSourceEntry[]> {
  if (matches.length === 0) return [];
  const used = new Set(usedSourceIds);
  const chosen = matches.filter((match) => used.has(match.source_id));
  const pool = chosen.length > 0 ? chosen : matches.slice(0, 3);

  const uriBySource = await loadSourceUris(supabase, [...new Set(pool.map((m) => m.source_id))]);

  const seen = new Set<string>();
  const entries: DraftSourceEntry[] = [];
  for (const match of pool) {
    if (seen.has(match.source_id)) continue;
    seen.add(match.source_id);
    entries.push({
      source_id: match.source_id,
      uri: uriBySource.get(match.source_id) ?? null,
      snippet: match.content.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX_CHARS),
    });
  }
  return entries;
}

async function loadSourceUris(
  supabase: SupabaseClient,
  sourceIds: string[]
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (sourceIds.length === 0) return map;
  const { data, error } = await supabase.from('kb_sources').select('id, uri').in('id', sourceIds);
  if (error) throw error;
  for (const row of (data ?? []) as unknown as { id: string; uri: string | null }[]) {
    map.set(row.id, row.uri);
  }
  return map;
}

async function loadOrgName(supabase: SupabaseClient, orgId: string): Promise<string> {
  const { data, error } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .maybeSingle();
  if (error) throw error;
  const name = (data as { name?: string } | null)?.name;
  return name && name.trim().length > 0 ? name : 'unser Unternehmen';
}

async function loadToneInstructions(
  supabase: SupabaseClient,
  orgId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('org_settings')
    .select('tone_instructions')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw error;
  return (data as { tone_instructions?: string | null } | null)?.tone_instructions ?? null;
}

async function loadContact(
  supabase: SupabaseClient,
  contactId: string
): Promise<LoadedContact | null> {
  const { data, error } = await supabase
    .from('contacts')
    .select('id, name, email, phone')
    .eq('id', contactId)
    .maybeSingle();
  if (error) throw error;
  return data ? (data as unknown as LoadedContact) : null;
}

// --- ai_runs logging ----------------------------------------------------------

interface AiRunLog {
  orgId: string;
  conversationId: string;
  step: AiRunStep;
  model: string;
  confidence?: number | null;
  latencyMs: number;
  costUsd?: number | null;
  inputSummary?: string | null;
  outputSummary?: string | null;
}

/** Append an ai_runs observability row. Summaries are PII-free by design. */
async function logAiRun(supabase: SupabaseClient, run: AiRunLog): Promise<void> {
  const { error } = await supabase.from('ai_runs').insert({
    org_id: run.orgId,
    conversation_id: run.conversationId,
    step: run.step,
    model: run.model,
    input_summary: run.inputSummary ?? null,
    output_summary: run.outputSummary ?? null,
    confidence: run.confidence ?? null,
    latency_ms: run.latencyMs,
    cost_usd: run.costUsd ?? null,
  });
  if (error) throw error;
}
