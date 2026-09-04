import {
  createLogger,
  ensureTicket,
  isPlaceholderSubject,
  type ConversationPriority,
  type EnsureTicketInput,
  type SupabaseClient,
  type TicketRef,
} from '@zendori/core';
import type { ClassificationResult, ExtractionResult } from '@zendori/ai';

const logger = createLogger('tickets');

// Worker-side wrapper around the shared ticket service (Phase 11). Ticket
// creation is a side effect of a decision the pipeline/voice/forms already
// made — it must NEVER fail that step: every error is logged (ids only, §7)
// and swallowed; schema skew (0030 not applied yet) is silent.

let skewWarned = false;

export async function ensureTicketForConversation(
  supabase: SupabaseClient,
  input: EnsureTicketInput
): Promise<TicketRef | null> {
  try {
    const result = await ensureTicket(supabase, input);
    if (result.outcome === 'unavailable') {
      if (!skewWarned) {
        skewWarned = true;
        logger.warn({ orgId: input.orgId }, 'tickets table missing — is migration 0030 applied?');
      }
      return null;
    }
    return result.ticket;
  } catch (err) {
    logger.warn(
      {
        orgId: input.orgId,
        conversationId: input.conversationId,
        origin: input.origin,
        err: { message: (err as Error)?.message, code: (err as { code?: string })?.code },
      },
      'ticket creation failed'
    );
    return null;
  }
}

export interface TicketSeed {
  subject: string | null;
  description: string | null;
  category: string | null;
  priority: ConversationPriority | null;
  openedMessageId: string | null;
}

/**
 * What the text pipeline knows about the request, in precedence order:
 * extraction subject > a non-placeholder conversation subject > the
 * classification intent; description = extraction > classification summary.
 * Pure — exported for tests.
 */
export function buildTicketSeed(args: {
  conv: { subject: string | null };
  classification: ClassificationResult | null;
  extraction: ExtractionResult | null;
  messageId: string;
}): TicketSeed {
  const { conv, classification, extraction } = args;
  const extractedSubject = extraction?.subject?.trim() || null;
  const convSubject = isPlaceholderSubject(conv.subject) ? null : (conv.subject?.trim() ?? null);
  const intent = classification?.intent?.trim() || null;
  return {
    subject: extractedSubject ?? convSubject ?? intent,
    description: extraction?.description?.trim() || classification?.summary?.trim() || null,
    category: extraction?.category?.trim() || null,
    priority: classification?.priority ?? null,
    openedMessageId: args.messageId,
  };
}
