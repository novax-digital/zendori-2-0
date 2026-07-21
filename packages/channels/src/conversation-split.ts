// Ticket separation ("Ticket-Trennung"): decides at INGEST time whether an
// inbound message continues the found conversation or opens a new one. The
// rule is a deterministic inactivity window per channel (channels.config,
// conversationSplitHours / conversation_split_hours) — no AI involvement.
//
// Invariants (see docs/ticket-splitting.md):
//  - `pending` conversations are the §6 waiting queue (pending handoff or a
//    promised callback) and are NEVER split — a split would cut the queue and
//    orphan the SLA reminder (0018).
//  - Absent/invalid window ⇒ never split (the pre-feature behavior).
//  - The basis is conversations.last_message_at (touched by trigger 0002 on
//    every in- AND outbound message): "inactivity" means NOBODY wrote.

export interface SplitCandidate {
  /** conversations.status: open | pending | resolved */
  status: string;
  /** conversations.last_message_at (ISO timestamp) — null on empty conversations. */
  lastMessageAt: string | null;
}

/**
 * True when the found conversation should be left alone and the incoming
 * message should start a NEW conversation instead.
 */
export function shouldStartNewConversation(
  candidate: SplitCandidate,
  splitHours: number | null | undefined,
  now: Date = new Date()
): boolean {
  if (!splitHours || !Number.isFinite(splitHours) || splitHours <= 0) return false;
  if (candidate.status === 'pending') return false;
  if (!candidate.lastMessageAt) return false;
  const last = Date.parse(candidate.lastMessageAt);
  if (Number.isNaN(last)) return false;
  return now.getTime() - last > splitHours * 60 * 60 * 1000;
}
