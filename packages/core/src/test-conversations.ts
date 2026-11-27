import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError } from './db.js';

// Test conversations (migration 0050, docs/webchat-test.md): started from the
// tab "Test" of a chat channel. They look and behave like a real conversation
// for the person trying the widget out, but nothing leaves Zendori because of
// them — no ticket, no e-mail to the team, no event to the customer's own
// system, no HubSpot. The database keeps notifications and events away
// (triggers); the places that decide in code ask here.

/**
 * SQLSTATE the 0050 guard on `tickets` raises for a test conversation. The
 * ticket service checks before it inserts; this only catches a writer that did
 * not.
 */
export const TEST_TICKET_REFUSED_CODE = 'ZT001';

/**
 * True when the conversation was started from a channel's "Test" tab. Works
 * with the service role and with a member's client (RLS). Before migration 0050
 * the column does not exist — then no conversation is a test.
 */
export async function isTestConversation(
  supabase: SupabaseClient,
  orgId: string,
  conversationId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('conversations')
    .select('is_test')
    .eq('org_id', orgId)
    .eq('id', conversationId)
    .maybeSingle();
  if (error) {
    if (isMissingColumnError(error)) return false;
    throw error;
  }
  return (data as { is_test?: unknown } | null)?.is_test === true;
}
