'use server';

// Phase 13 — inbox decision on a data action that waits for confirmation. The
// web app only flips the run's state (SECURITY DEFINER function, atomic, one
// decision per run); the WORKER performs the call to the end system and writes
// the result, which the inbox picks up through realtime.
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { hasConversationEdit } from '@/lib/access';
import { href } from '@/lib/href';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const decideSchema = z.object({
  org: z.uuid(),
  conversationId: z.uuid(),
  runId: z.uuid(),
  decision: z.enum(['approve', 'reject']),
});

function text(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Back to the same conversation with the list filters intact. */
function inboxUrl(formData: FormData, message: { error?: string; notice?: string }): string {
  const status = text(formData.get('filterStatus'));
  const channel = text(formData.get('filterChannel'));
  return href('/inbox', {
    org: text(formData.get('org')),
    c: text(formData.get('conversationId')),
    status: ['open', 'pending', 'resolved', 'hubspot_sent'].includes(status) ? status : 'all',
    channel: z.uuid().safeParse(channel).success ? channel : 'all',
    q: text(formData.get('filterQ')).slice(0, 200),
    ...message,
  });
}

export async function decideActionRun(formData: FormData): Promise<void> {
  // inbox edit + access to the conversation's channel (channel-scoped members)
  if (!(await hasConversationEdit(formData.get('org'), formData.get('conversationId')))) {
    redirect(inboxUrl(formData, { error: 'Keine Berechtigung.' }));
  }
  const parsed = decideSchema.safeParse({
    org: formData.get('org'),
    conversationId: formData.get('conversationId'),
    runId: formData.get('runId'),
    decision: formData.get('decision'),
  });
  if (!parsed.success) {
    redirect(inboxUrl(formData, { error: 'Aktion konnte nicht bestätigt werden.' }));
  }
  const { org, conversationId, runId, decision } = parsed.data;

  const supabase = await createSupabaseServerClient();
  // The run must belong to THIS conversation — the guard above checked access
  // to the conversation, not to an arbitrary run id from the form.
  const { data: run } = await supabase
    .from('action_runs')
    .select('id')
    .eq('org_id', org)
    .eq('conversation_id', conversationId)
    .eq('id', runId)
    .maybeSingle();
  if (!run) redirect(inboxUrl(formData, { error: 'Aktion nicht gefunden.' }));

  const { data: state, error } = await supabase.rpc('decide_action_run', {
    p_run_id: runId,
    p_approve: decision === 'approve',
  });
  if (error) redirect(inboxUrl(formData, { error: 'Aktion konnte nicht bestätigt werden.' }));

  revalidatePath('/inbox');
  if (state === null) {
    redirect(inboxUrl(formData, { notice: 'Über diese Aktion wurde bereits entschieden.' }));
  }
  redirect(
    inboxUrl(formData, {
      notice:
        decision === 'approve'
          ? 'Aktion bestätigt — sie wird jetzt ausgeführt.'
          : 'Aktion verworfen. Es wurde nichts ausgeführt.',
    })
  );
}
