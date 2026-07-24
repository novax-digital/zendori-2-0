'use server';

// Review actions for the learning loop (migration 0020): a human approves or
// rejects distilled Q&A proposals. Approval only ENSURES the per-org system
// source ("Gelernte Antworten", kb_sources.is_learned) exists and pokes it to
// 'pending' — the WORKER compiles the source's chunks directly from all
// approved rows at index time (race-free: no web-side read-modify-write, no
// storage file to clobber). RLS scopes every user-scoped query (§7).

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireAreaEdit } from '@/lib/access';

/** Display name of the system source (never read from storage — worker-compiled). */
const LEARNED_SOURCE_NAME = 'gelernte-antworten';
const LEARNED_KB_NAME = 'Gelernte Antworten';
const LEARNED_KB_DESCRIPTION =
  'Automatisch aus freigegebenen Mitarbeiter-Antworten gelernte Frage-Antwort-Paare.';

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function learnedUrl(org: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/settings/knowledge/learned?${params.toString()}`;
}

const decisionSchema = z.object({
  org: z.uuid(),
  id: z.uuid(),
});

const approveSchema = decisionSchema.extend({
  question: z.string().min(3).max(500),
  answer: z.string().min(3).max(4000),
});

/**
 * Approve a proposal (optionally edited in the review form), then rebuild and
 * re-index the learned-answers source. The status claim (proposed→approved)
 * guards against double-submits and concurrent reviewers.
 */
export async function approveLearnedAnswer(formData: FormData): Promise<void> {
  await requireAreaEdit(formData.get('org'), 'knowledge', (o) => learnedUrl(o, { error: 'Keine Berechtigung für diesen Bereich.' }));
  const parsed = approveSchema.safeParse({
    org: formData.get('org'),
    id: formData.get('id'),
    question: textField(formData.get('question')),
    answer: textField(formData.get('answer')),
  });
  if (!parsed.success) {
    redirect(
      learnedUrl(textField(formData.get('org')), {
        error: 'Bitte Frage (3–500 Zeichen) und Antwort (3–4000 Zeichen) angeben.',
      })
    );
  }
  const { org, id, question, answer } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: claimed, error } = await supabase
    .from('learned_answers')
    .update({
      status: 'approved',
      question,
      answer,
      decided_by: user.id,
      decided_at: new Date().toISOString(),
    })
    .eq('org_id', org)
    .eq('id', id)
    .eq('status', 'proposed')
    .select('id');
  if (error || !claimed || claimed.length === 0) {
    redirect(learnedUrl(org, { error: 'Der Vorschlag ist nicht mehr verfügbar.' }));
  }

  const poke = await pokeLearnedSource(supabase, org);
  if (!poke.ok) {
    redirect(
      learnedUrl(org, {
        error: `Übernommen, aber die Wissensquelle konnte nicht aktualisiert werden: ${poke.error}`,
      })
    );
  }

  revalidatePath('/settings/knowledge');
  redirect(
    learnedUrl(org, {
      notice: 'Antwort übernommen — die Wissensdatenbank wird neu indiziert.',
    })
  );
}

/** Reject a proposal (proposed→rejected). */
export async function rejectLearnedAnswer(formData: FormData): Promise<void> {
  await requireAreaEdit(formData.get('org'), 'knowledge', (o) => learnedUrl(o, { error: 'Keine Berechtigung für diesen Bereich.' }));
  const parsed = decisionSchema.safeParse({
    org: formData.get('org'),
    id: formData.get('id'),
  });
  if (!parsed.success) {
    redirect(learnedUrl(textField(formData.get('org')), { error: 'Ungültige Anfrage.' }));
  }
  const { org, id } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { error } = await supabase
    .from('learned_answers')
    .update({ status: 'rejected', decided_by: user.id, decided_at: new Date().toISOString() })
    .eq('org_id', org)
    .eq('id', id)
    .eq('status', 'proposed');
  if (error) {
    redirect(learnedUrl(org, { error: 'Vorschlag konnte nicht abgelehnt werden.' }));
  }

  revalidatePath('/settings/knowledge');
  redirect(learnedUrl(org, { notice: 'Vorschlag abgelehnt.' }));
}

/** Retry a failed distillation: error→candidate re-arms the worker poll. */
export async function retryLearnedCandidate(formData: FormData): Promise<void> {
  await requireAreaEdit(formData.get('org'), 'knowledge', (o) => learnedUrl(o, { error: 'Keine Berechtigung für diesen Bereich.' }));
  const parsed = decisionSchema.safeParse({
    org: formData.get('org'),
    id: formData.get('id'),
  });
  if (!parsed.success) {
    redirect(learnedUrl(textField(formData.get('org')), { error: 'Ungültige Anfrage.' }));
  }
  const { org, id } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('learned_answers')
    .update({ status: 'candidate' })
    .eq('org_id', org)
    .eq('id', id)
    .eq('status', 'error');
  if (error) {
    redirect(learnedUrl(org, { error: 'Erneuter Versuch konnte nicht gestartet werden.' }));
  }
  redirect(learnedUrl(org, { notice: 'Wird erneut verarbeitet.' }));
}

interface PokeResult {
  ok: boolean;
  error?: string;
}

/**
 * Ensure the per-org learned-answers SYSTEM source exists (kb_sources.is_learned,
 * unique per org via partial index) and poke it to 'pending'. The worker
 * compiles its chunks from all approved rows at index time, so this action
 * carries no content — concurrent approvals at worst poke twice (idempotent).
 * Find-or-create races resolve via the unique index (23505 → reuse winner).
 */
async function pokeLearnedSource(supabase: SupabaseClient, org: string): Promise<PokeResult> {
  const { data: sourceRow, error: sourceError } = await supabase
    .from('kb_sources')
    .select('id')
    .eq('org_id', org)
    .eq('is_learned', true)
    .maybeSingle();
  if (sourceError) return { ok: false, error: 'Wissensquelle konnte nicht geladen werden.' };

  let sourceId = (sourceRow as { id: string } | null)?.id ?? null;
  if (!sourceId) {
    const created = await createLearnedSource(supabase, org);
    if (!created.ok) return { ok: false, error: created.error };
    sourceId = created.sourceId;
  }

  const { error: pendingError } = await supabase
    .from('kb_sources')
    .update({ status: 'pending' })
    .eq('org_id', org)
    .eq('id', sourceId);
  if (pendingError) return { ok: false, error: 'Neuindizierung konnte nicht gestartet werden.' };

  return { ok: true };
}

/** Create KB + system source; on a lost create race reuse the winner's source. */
async function createLearnedSource(
  supabase: SupabaseClient,
  org: string
): Promise<{ ok: true; sourceId: string } | { ok: false; error: string }> {
  const kb = await findOrCreateLearnedKb(supabase, org);
  if (!kb) return { ok: false, error: 'Wissensdatenbank konnte nicht angelegt werden.' };

  const { data: created, error: createError } = await supabase
    .from('kb_sources')
    .insert({
      org_id: org,
      knowledge_base_id: kb.id,
      type: 'file',
      uri: LEARNED_SOURCE_NAME,
      is_learned: true,
      status: 'pending',
    })
    .select('id')
    .single();
  if (!createError && created) {
    return { ok: true, sourceId: (created as { id: string }).id };
  }

  if ((createError as { code?: string } | null)?.code === '23505') {
    // Lost the one-learned-source-per-org race — reuse the winner's source and
    // clean up our just-created, still-empty KB shell (best effort).
    const { data: raced } = await supabase
      .from('kb_sources')
      .select('id')
      .eq('org_id', org)
      .eq('is_learned', true)
      .maybeSingle();
    const racedId = (raced as { id: string } | null)?.id;
    if (racedId) {
      if (kb.created) await deleteKbIfEmpty(supabase, org, kb.id);
      return { ok: true, sourceId: racedId };
    }
  }
  return { ok: false, error: 'Wissensquelle konnte nicht angelegt werden.' };
}

async function deleteKbIfEmpty(supabase: SupabaseClient, org: string, kbId: string): Promise<void> {
  const { count } = await supabase
    .from('kb_sources')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', org)
    .eq('knowledge_base_id', kbId);
  if ((count ?? 0) === 0) {
    await supabase.from('knowledge_bases').delete().eq('org_id', org).eq('id', kbId);
  }
}

/** Find the "Gelernte Antworten" KB by name or create it (created flag for cleanup). */
async function findOrCreateLearnedKb(
  supabase: SupabaseClient,
  org: string
): Promise<{ id: string; created: boolean } | null> {
  const { data: existing } = await supabase
    .from('knowledge_bases')
    .select('id')
    .eq('org_id', org)
    .eq('name', LEARNED_KB_NAME)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const existingId = (existing as { id: string } | null)?.id;
  if (existingId) return { id: existingId, created: false };

  const { data: created, error } = await supabase
    .from('knowledge_bases')
    .insert({ org_id: org, name: LEARNED_KB_NAME, description: LEARNED_KB_DESCRIPTION })
    .select('id')
    .single();
  if (error || !created) return null;
  return { id: (created as { id: string }).id, created: true };
}
