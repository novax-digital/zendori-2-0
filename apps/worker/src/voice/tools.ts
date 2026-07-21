import { z } from 'zod';
import { retrieveRelevantChunks, EMBEDDING_MODEL } from '@zendori/ai';
import type { SupabaseClient } from '@zendori/core';
import {
  hasConfiguredHours,
  isWithinBusinessHours,
  type BusinessHours,
  type VoiceChannelConfig,
} from '@zendori/channels';

// Voice function-tool handlers. All run in the worker with the org_id bound
// from the voice_calls row (server truth — never from the model), so RLS-scoped
// tenant isolation holds (§7/§9). Each returns a JSON-serializable object that
// is sent back as the function_call_output. Tool arguments arrive as a JSON
// string from the model — parsed + zod-validated here, never trusted.

export interface ToolContext {
  supabase: SupabaseClient;
  orgId: string;
  conversationId: string;
  channelId: string;
  channelConfig: VoiceChannelConfig;
  /** Resolved from the assigned agent (0011): gates kb_search in intake mode. */
  agentMode: 'answer' | 'intake_only';
  /** Agent's linked knowledge bases (0012): null = all, [] = none. */
  knowledgeBaseIds: string[] | null;
  /** 0018: OFF suppresses only the low_confidence handoff trigger. */
  handoffEnabled: boolean;
  /**
   * Org business hours (defensively parsed) — the live-transfer gate is
   * evaluated HERE at tool-call time, not at call start, so the mid-call
   * boundary (call starts 16:58, handoff 17:02) is correct by construction.
   */
  businessHours: BusinessHours | null;
  /**
   * Explicit transfer permission: false in the agent-less safe-intake fallback
   * (no owner-configured behavior → never transfer). Deliberately its own flag
   * — overloading businessHours=null would give null two meanings.
   */
  allowTransfer: boolean;
}

export type ToolResult = { ok: true; [key: string]: unknown } | { ok: false; error: string };

const KB_SNIPPET_MAX_CHARS = 800;

const kbSearchArgsSchema = z.object({ query: z.string().min(1).max(2000) });

export async function kbSearchTool(ctx: ToolContext, rawArgs: unknown): Promise<ToolResult> {
  const parsed = kbSearchArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: 'invalid arguments' };
  if (ctx.agentMode === 'intake_only') {
    return { ok: false, error: 'kb_search ist in diesem Modus nicht verfügbar' };
  }

  const start = Date.now();
  // Hybrid stage only — the Haiku rerank would add ~1s of silence to a live
  // call; the caller's short spoken questions are exactly where the keyword
  // leg shines anyway. Smaller pool keeps the tool result compact.
  const { matches, embedCostUsd, searchMode } = await retrieveRelevantChunks(
    ctx.supabase,
    ctx.orgId,
    parsed.data.query,
    // minSimilarity 0.3: without the rerank noise filter, voice keeps the
    // legacy vector cutoff (0014) — the 0.15 gate is only safe WITH reranking.
    {
      knowledgeBaseIds: ctx.knowledgeBaseIds,
      poolCount: 12,
      finalCount: 6,
      rerank: false,
      minSimilarity: 0.3,
    }
  );
  await ctx.supabase.from('ai_runs').insert({
    org_id: ctx.orgId,
    conversation_id: ctx.conversationId,
    step: 'retrieve',
    model: EMBEDDING_MODEL,
    latency_ms: Date.now() - start,
    cost_usd: embedCostUsd,
    input_summary: 'voice.kb_search',
    output_summary: `matches=${matches.length} mode=${searchMode}`,
  });

  return {
    ok: true,
    chunks: matches.map((m) => ({
      content: m.content.slice(0, KB_SNIPPET_MAX_CHARS),
      source_id: m.source_id,
    })),
  };
}

const createTicketArgsSchema = z.object({
  subject: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
  name: z.string().max(200).optional(),
  callback_number: z.string().max(50).optional(),
  email: z.string().max(200).optional(),
});

/**
 * Model-transcribed from speech: only a syntactically valid address may ever
 * reach contacts.email (an invalid value would break replies). Invalid input
 * drops the email but must NOT fail the whole ticket.
 */
function validEmailOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return z.email().safeParse(value).success ? value.toLowerCase() : undefined;
}

/**
 * The conversation IS the ticket: set subject, fill contact gaps from what the
 * caller said, and add a structured system message so agents see the intake at
 * a glance. Post-call classify/extract refines priority afterwards.
 */
export async function createTicketTool(ctx: ToolContext, rawArgs: unknown): Promise<ToolResult> {
  const parsed = createTicketArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: 'invalid arguments' };
  const args = parsed.data;
  const email = validEmailOrUndefined(args.email);

  // status='pending' (one-queue principle, 0018): every promised callback —
  // also from the intake/suppressed flows that never flip mode — is visible in
  // the inbox pending queue and covered by the SLA reminder.
  const { error: convError } = await ctx.supabase
    .from('conversations')
    .update({ subject: args.subject, status: 'pending' })
    .eq('org_id', ctx.orgId)
    .eq('id', ctx.conversationId);
  if (convError) return { ok: false, error: 'Ticket konnte nicht gespeichert werden' };

  // Fill contact gaps (never overwrite existing values — mirrors fillContactGaps).
  const { data: convRow } = await ctx.supabase
    .from('conversations')
    .select('contact_id')
    .eq('org_id', ctx.orgId)
    .eq('id', ctx.conversationId)
    .maybeSingle();
  const contactId = (convRow as { contact_id: string | null } | null)?.contact_id;
  if (contactId && (args.name || email)) {
    const { data: contactRow } = await ctx.supabase
      .from('contacts')
      .select('name, email')
      .eq('org_id', ctx.orgId)
      .eq('id', contactId)
      .maybeSingle();
    const contact = contactRow as { name: string | null; email: string | null } | null;
    const patch: Record<string, string> = {};
    if (args.name && !contact?.name) patch.name = args.name;
    if (email && !contact?.email) patch.email = email;
    if (Object.keys(patch).length > 0) {
      await ctx.supabase.from('contacts').update(patch).eq('org_id', ctx.orgId).eq('id', contactId);
    }
  }

  const lines = [
    `Ticket aufgenommen: ${args.subject}`,
    args.description,
    ...(args.name ? [`Name: ${args.name}`] : []),
    ...(args.callback_number ? [`Rückruf: ${args.callback_number}`] : []),
    ...(email ? [`E-Mail: ${email}`] : []),
  ];
  await ctx.supabase.from('messages').insert({
    org_id: ctx.orgId,
    conversation_id: ctx.conversationId,
    channel_id: ctx.channelId,
    direction: 'out',
    sender_type: 'system',
    content: lines.join('\n'),
    content_type: 'text',
    processing_state: null,
  });

  return { ok: true, ticket_ref: ctx.conversationId };
}

const handoffArgsSchema = z.object({
  reason: z.enum(['user_request', 'low_confidence', 'keyword']),
});

export type VoiceHandoffDecision = 'transfer' | 'callback' | 'suppress';

export interface DecideVoiceHandoffInput {
  reason: 'user_request' | 'low_confidence' | 'keyword';
  /** agents.handoff_enabled (0018). */
  handoffEnabled: boolean;
  /** Agent-less safe-intake fallback sets this false — never transfer. */
  allowTransfer: boolean;
  /** Voice channel transferNumber (may be absent/blank). */
  transferNumber: string | undefined;
  /** Org business hours; null = never configured. */
  businessHours: BusinessHours | null;
  now: Date;
}

/**
 * The v1 handoff decision matrix (owner decision 2026-07-21), pure:
 * - Toggle OFF suppresses ONLY reason='low_confidence' — user_request and
 *   keyword always hand off (never stonewall an explicit human wish; keywords
 *   are org policy). The reason enum is model-chosen, so this is a best-effort
 *   gate, not a guarantee — documented residual risk.
 * - Live transfer requires: allowed (real agent), a transfer number, and being
 *   within business hours. Hours with NO configured weekday (or null) count as
 *   NOT CONFIGURED → transfer allowed (the number is the opt-in).
 * - Everything else → callback ticket flow.
 */
export function decideVoiceHandoff(input: DecideVoiceHandoffInput): VoiceHandoffDecision {
  if (!input.handoffEnabled && input.reason === 'low_confidence') return 'suppress';
  const number = input.transferNumber?.trim();
  if (!input.allowTransfer || !number) return 'callback';
  const hoursConfigured = hasConfiguredHours(input.businessHours);
  const within = hoursConfigured
    ? isWithinBusinessHours(input.now, input.businessHours!)
    : true; // not configured → the transfer number alone is the opt-in
  return within ? 'transfer' : 'callback';
}

export type HandoffOutcome =
  | { ok: true; action: 'transfer'; transfer_number: string; eventId?: string }
  | { ok: true; action: 'callback'; instruction: string }
  | { ok: true; action: 'no_handoff'; instruction: string }
  | { ok: false; error: string };

/**
 * Insert a handoff event with the 0018 outcome; pre-migration (42703) retries
 * the legacy shape. Returns the new event id when available.
 */
async function insertVoiceHandoffEvent(
  ctx: ToolContext,
  reason: string,
  outcome: string
): Promise<string | null> {
  const { data, error } = await ctx.supabase
    .from('handoff_events')
    .insert({
      org_id: ctx.orgId,
      conversation_id: ctx.conversationId,
      reason,
      outcome,
      triggered_by: null,
    })
    .select('id')
    .single();
  if (error && (error as { code?: string }).code === '42703') {
    await ctx.supabase.from('handoff_events').insert({
      org_id: ctx.orgId,
      conversation_id: ctx.conversationId,
      reason,
      triggered_by: null,
    });
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Hand the conversation to a human (§6 + 0018): decide transfer vs callback vs
 * suppress via the pure matrix above (business hours evaluated NOW), then flip
 * mode/status idempotently (conditional claim on mode='bot' — model retries of
 * handoff_human never produce duplicate events) and record the outcome.
 * The eventId in the transfer outcome is for the CallSession's REFER-result
 * correlation ONLY — it is stripped before the output reaches the model.
 */
export async function handoffTool(ctx: ToolContext, rawArgs: unknown): Promise<HandoffOutcome> {
  const parsed = handoffArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: 'invalid arguments' };
  const reason = parsed.data.reason;

  const decision = decideVoiceHandoff({
    reason,
    handoffEnabled: ctx.handoffEnabled,
    allowTransfer: ctx.allowTransfer,
    transferNumber: ctx.channelConfig.transferNumber,
    businessHours: ctx.businessHours,
    now: new Date(),
  });

  if (decision === 'suppress') {
    // No mode flip, no transfer — but countable (one event per conversation).
    const { data: existing } = await ctx.supabase
      .from('handoff_events')
      .select('id')
      .eq('org_id', ctx.orgId)
      .eq('conversation_id', ctx.conversationId)
      .eq('outcome', 'suppressed')
      .limit(1);
    if (!existing || existing.length === 0) {
      await insertVoiceHandoffEvent(ctx, reason, 'suppressed');
    }
    return {
      ok: true,
      action: 'no_handoff',
      instruction:
        'Eine Übergabe ist hierfür nicht vorgesehen. Sage ehrlich, dass du das gerade nicht beantworten kannst, und biete an, das Anliegen aufzunehmen (create_ticket) — ein Kollege meldet sich dann.',
    };
  }

  // Idempotent claim: only the bot→human transition inserts the event. A
  // duplicate handoff_human (model retry) recomputes the action without a
  // second event.
  const { data: claimed, error: convError } = await ctx.supabase
    .from('conversations')
    .update({ mode: 'human', status: 'pending' })
    .eq('org_id', ctx.orgId)
    .eq('id', ctx.conversationId)
    .eq('mode', 'bot')
    .select('id');
  if (convError) return { ok: false, error: 'Übergabe fehlgeschlagen' };
  const isFirstHandoff = (claimed ?? []).length > 0;

  if (decision === 'transfer') {
    const eventId = isFirstHandoff
      ? await insertVoiceHandoffEvent(ctx, reason, 'pending_human')
      : null;
    return {
      ok: true,
      action: 'transfer',
      transfer_number: ctx.channelConfig.transferNumber!.trim(),
      ...(eventId ? { eventId } : {}),
    };
  }

  if (isFirstHandoff) await insertVoiceHandoffEvent(ctx, reason, 'callback_ticket');
  const hoursConfigured = hasConfiguredHours(ctx.businessHours);
  const outsideHours =
    hoursConfigured && !isWithinBusinessHours(new Date(), ctx.businessHours!);
  return {
    ok: true,
    action: 'callback',
    instruction: outsideHours
      ? 'Wir sind gerade außerhalb der Geschäftszeiten — kein Live-Transfer. Sage das ehrlich, biete einen Rückruf am nächsten Werktag an: erfrage Name und Rückrufnummer, fasse das Anliegen zusammen, rufe create_ticket auf und beende dann das Gespräch mit end_call.'
      : 'Kein Live-Transfer verfügbar. Biete dem Anrufer einen Rückruf an: erfrage Name und Rückrufnummer, fasse das Anliegen zusammen, rufe create_ticket auf und beende dann das Gespräch mit end_call.',
  };
}
