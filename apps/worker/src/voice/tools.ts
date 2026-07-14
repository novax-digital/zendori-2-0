import { z } from 'zod';
import { retrieveRelevantChunks, EMBEDDING_MODEL } from '@zendori/ai';
import type { SupabaseClient } from '@zendori/core';
import type { VoiceChannelConfig } from '@zendori/channels';

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
    { knowledgeBaseIds: ctx.knowledgeBaseIds, poolCount: 12, finalCount: 6, rerank: false }
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

  const { error: convError } = await ctx.supabase
    .from('conversations')
    .update({ subject: args.subject })
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

export type HandoffOutcome =
  | { ok: true; action: 'transfer'; transfer_number: string }
  | { ok: true; action: 'callback'; instruction: string }
  | { ok: false; error: string };

/**
 * Hand the conversation to a human (§6): flip mode/status, record the
 * handoff_event, then either signal a live transfer (config.transferNumber set —
 * the CallSession performs the REST refer) or instruct the model to offer a
 * callback and finish via create_ticket + end_call.
 */
export async function handoffTool(ctx: ToolContext, rawArgs: unknown): Promise<HandoffOutcome> {
  const parsed = handoffArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: 'invalid arguments' };

  const { error: convError } = await ctx.supabase
    .from('conversations')
    .update({ mode: 'human', status: 'pending' })
    .eq('org_id', ctx.orgId)
    .eq('id', ctx.conversationId);
  if (convError) return { ok: false, error: 'Übergabe fehlgeschlagen' };

  await ctx.supabase.from('handoff_events').insert({
    org_id: ctx.orgId,
    conversation_id: ctx.conversationId,
    reason: parsed.data.reason,
    triggered_by: null,
  });

  const transferNumber = ctx.channelConfig.transferNumber;
  if (transferNumber && transferNumber.trim().length > 0) {
    return { ok: true, action: 'transfer', transfer_number: transferNumber.trim() };
  }
  return {
    ok: true,
    action: 'callback',
    instruction:
      'Kein Live-Transfer verfügbar. Biete dem Anrufer einen Rückruf an: erfrage Name und Rückrufnummer, fasse das Anliegen zusammen, rufe create_ticket auf und beende dann das Gespräch mit end_call.',
  };
}
