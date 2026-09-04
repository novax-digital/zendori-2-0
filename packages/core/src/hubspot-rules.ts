import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isMissingColumnError, isMissingRelationError } from './db.js';
import { syncRulesSchema, type SyncRules } from './schemas.js';

// HubSpot sync rules (Phase 6 + Phase 11b): TWO independent streams, each with
// its own rule (all | channels | manual) and its own pipeline in
// integrations.config — "Konversationen → HubSpot" (the Phase-6 sync, anchored
// on the conversation) and "Tickets → HubSpot" (anchored on the ticket).
// integrations.rules is either the legacy flat shape (= the conversation
// stream; tickets default to manual) or { conversations, tickets }.

export interface HubspotSyncRules {
  conversations: SyncRules;
  tickets: SyncRules;
}

const MANUAL: SyncRules = { mode: 'manual' };

const twoStreamSchema = z.object({
  conversations: syncRulesSchema.optional(),
  tickets: syncRulesSchema.optional(),
});

/** Tolerant jsonb → rules for both streams (unknown/invalid ⇒ manual/manual). */
export function parseHubspotSyncRules(raw: unknown): HubspotSyncRules {
  const legacy = syncRulesSchema.safeParse(raw);
  if (legacy.success) return { conversations: legacy.data, tickets: MANUAL };
  const two = twoStreamSchema.safeParse(raw);
  if (two.success) {
    return { conversations: two.data.conversations ?? MANUAL, tickets: two.data.tickets ?? MANUAL };
  }
  return { conversations: MANUAL, tickets: MANUAL };
}

/** Does an automatic sync rule cover this channel? (pure) */
export function hubspotRuleApplies(rules: SyncRules, channelId: string): boolean {
  switch (rules.mode) {
    case 'all':
      return true;
    case 'channels':
      return rules.channel_ids.includes(channelId);
    case 'manual':
      return false;
  }
}

/**
 * Should the ticket stream (re)sync this ticket automatically? Rules cover the
 * channel, OR the ticket already lives in HubSpot (once sent, follow-ups keep
 * flowing even under 'manual' — the button's promise).
 */
export function ticketSyncWanted(
  rules: SyncRules,
  channelId: string,
  alreadySynced: boolean
): boolean {
  return alreadySynced || hubspotRuleApplies(rules, channelId);
}

async function loadActiveRules(
  supabase: SupabaseClient,
  orgId: string
): Promise<HubspotSyncRules | null> {
  const { data, error } = await supabase
    .from('integrations')
    .select('rules')
    .eq('org_id', orgId)
    .eq('type', 'hubspot')
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return parseHubspotSyncRules((data as { rules: unknown }).rules);
}

/**
 * Arm the ticket-stream sync for one ticket (tickets.hubspot_sync_requested_at)
 * when the rules cover its channel or it was already sent. Best-effort: never
 * throws (a sync request must never break ticket creation); returns whether a
 * request was written.
 */
export async function requestTicketHubspotSync(
  supabase: SupabaseClient,
  input: { orgId: string; channelId: string; ticketId: string; alreadySynced?: boolean }
): Promise<boolean> {
  try {
    const rules = await loadActiveRules(supabase, input.orgId);
    if (!rules) return false;
    if (!ticketSyncWanted(rules.tickets, input.channelId, input.alreadySynced === true)) return false;
    const { error } = await supabase
      .from('tickets')
      .update({ hubspot_sync_requested_at: new Date().toISOString() })
      .eq('id', input.ticketId)
      .eq('org_id', input.orgId);
    if (error && !(isMissingRelationError(error) || isMissingColumnError(error))) throw error;
    return !error;
  } catch {
    return false;
  }
}

/**
 * A new inbound message / post-call refinement on a conversation: re-arm the
 * NEWEST non-resolved ticket of it (attach rule v2 allows several — every open
 * ticket would otherwise receive the same follow-up note) when the ticket
 * stream covers it, so follow-ups reach the HubSpot ticket as notes. Best-effort.
 */
export async function requestConversationTicketsResync(
  supabase: SupabaseClient,
  input: { orgId: string; channelId: string; conversationId: string }
): Promise<void> {
  try {
    const rules = await loadActiveRules(supabase, input.orgId);
    if (!rules) return;
    const { data, error } = await supabase
      .from('tickets')
      .select('id, hubspot_ticket_id')
      .eq('org_id', input.orgId)
      .eq('conversation_id', input.conversationId)
      .neq('status', 'resolved')
      .order('opened_at', { ascending: false })
      .limit(1);
    if (error) {
      if (isMissingRelationError(error) || isMissingColumnError(error)) return;
      throw error;
    }
    const now = new Date().toISOString();
    for (const row of (data ?? []) as { id: string; hubspot_ticket_id: string | null }[]) {
      if (!ticketSyncWanted(rules.tickets, input.channelId, row.hubspot_ticket_id !== null)) continue;
      await supabase
        .from('tickets')
        .update({ hubspot_sync_requested_at: now })
        .eq('id', row.id)
        .eq('org_id', input.orgId);
    }
  } catch {
    // best-effort
  }
}
