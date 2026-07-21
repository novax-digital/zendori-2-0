import {
  businessHoursSchema,
  hasConfiguredHours,
  isWithinBusinessHours,
  type BusinessHours,
} from '@zendori/channels';
import type { Logger, SupabaseClient } from '@zendori/core';
import { toErrorInfo } from '../db.js';

// Handoff SLA reminder (0018, v1.5): a pending handoff without an agent
// reaction for longer than org_settings.handoff_sla_minutes gets ONE internal
// note. Team-facing only — the customer already got the handoff-time ack.
// Rules (owner decision 2026-07-21):
//  - fires only WITHIN business hours (an overnight handoff reminds shortly
//    after opening, never at 03:00); unconfigured hours → always eligible
//  - idempotent via a details.reminded_at marker on the handoff event
//  - voice events with outcome='transferred' are excluded (the call was handed
//    to a phone — the inbox row is closed by convention, not by SLA)
//  - suppressed events are excluded (nothing was promised to the customer)

/** Sweep at most once a minute — the scan tick itself runs every ~3s. */
const SLA_SWEEP_MIN_INTERVAL_MS = 60_000;
const EVENT_BATCH = 25;

let lastSweepAt = 0;

/** Pure: has the SLA elapsed for an event created at `createdAtIso`? */
export function isEventOverdue(createdAtIso: string, slaMinutes: number, now: Date): boolean {
  const created = Date.parse(createdAtIso);
  if (Number.isNaN(created)) return false;
  return now.getTime() - created >= slaMinutes * 60_000;
}

/** Test seam: reset the module-level sweep clock. */
export function resetSlaSweepClock(): void {
  lastSweepAt = 0;
}

export async function remindOverdueHandoffs(
  supabase: SupabaseClient,
  logger: Logger
): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastSweepAt < SLA_SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt = nowMs;
  const now = new Date(nowMs);

  const { data: orgRows, error } = await supabase
    .from('org_settings')
    .select('org_id, handoff_sla_minutes, business_hours')
    .not('handoff_sla_minutes', 'is', null);
  if (error) {
    // 0018 not applied yet — silently skip (same skew tolerance as elsewhere).
    if ((error as { code?: string }).code === '42703') return;
    throw error;
  }

  for (const orgRow of (orgRows ?? []) as {
    org_id: string;
    handoff_sla_minutes: number;
    business_hours: unknown;
  }[]) {
    const slaMinutes = orgRow.handoff_sla_minutes;
    if (!Number.isInteger(slaMinutes) || slaMinutes <= 0) continue;

    let hours: BusinessHours | null = null;
    if (orgRow.business_hours != null) {
      const parsed = businessHoursSchema.safeParse(orgRow.business_hours);
      hours = parsed.success ? parsed.data : null;
    }
    // Remind only within business hours; unconfigured hours → always eligible.
    if (hasConfiguredHours(hours) && !isWithinBusinessHours(now, hours!)) continue;

    const cutoff = new Date(nowMs - slaMinutes * 60_000).toISOString();
    const { data: eventRows, error: eventError } = await supabase
      .from('handoff_events')
      .select('id, conversation_id, created_at, details')
      .eq('org_id', orgRow.org_id)
      .in('outcome', ['pending_human', 'callback_ticket'])
      .lt('created_at', cutoff)
      .is('details->reminded_at', null)
      .order('created_at', { ascending: true })
      .limit(EVENT_BATCH);
    if (eventError) {
      logger.warn(
        { orgId: orgRow.org_id, err: toErrorInfo(eventError) },
        'handoff sla event query failed'
      );
      continue;
    }

    for (const event of (eventRows ?? []) as {
      id: string;
      conversation_id: string;
      created_at: string;
      details: Record<string, unknown> | null;
    }[]) {
      const markReminded = async (): Promise<void> => {
        await supabase
          .from('handoff_events')
          .update({ details: { ...(event.details ?? {}), reminded_at: now.toISOString() } })
          .eq('org_id', orgRow.org_id)
          .eq('id', event.id);
      };

      // Still waiting? (one-queue principle: status='pending' is the queue key)
      const { data: conv } = await supabase
        .from('conversations')
        .select('id')
        .eq('org_id', orgRow.org_id)
        .eq('id', event.conversation_id)
        .eq('status', 'pending')
        .maybeSingle();
      if (!conv) {
        await markReminded(); // resolved meanwhile — never re-check
        continue;
      }

      // Did a human already react after the handoff?
      const { data: agentReply } = await supabase
        .from('messages')
        .select('id')
        .eq('conversation_id', event.conversation_id)
        .eq('sender_type', 'agent')
        .gt('created_at', event.created_at)
        .limit(1);
      if (agentReply && agentReply.length > 0) {
        await markReminded();
        continue;
      }

      const { error: noteError } = await supabase.from('notes').insert({
        org_id: orgRow.org_id,
        conversation_id: event.conversation_id,
        author_id: null,
        content: `⏰ SLA-Erinnerung: Diese Übergabe wartet seit mehr als ${slaMinutes} Minuten ohne Reaktion.`,
      });
      if (noteError) {
        logger.warn(
          { orgId: orgRow.org_id, err: toErrorInfo(noteError) },
          'handoff sla note insert failed'
        );
        continue; // do not mark — retry next sweep
      }
      await markReminded();
      logger.info(
        { orgId: orgRow.org_id, conversationId: event.conversation_id },
        'handoff sla reminder created'
      );
    }
  }
}
