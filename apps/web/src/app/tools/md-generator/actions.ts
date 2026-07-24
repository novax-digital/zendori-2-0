'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { canViewArea } from '@zendori/core';
import { getMemberAccess, requireAreaEdit } from '@/lib/access';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { generateSiteMarkdown } from '@/lib/tools/md-crawler';

const KB_BUCKET = 'kb-files';

export type GenerateResult =
  | { ok: true; markdown: string; pageCount: number; skipped: string[]; title: string }
  | { ok: false; error: string };

/** Crawl + convert — returns the Markdown to the client (preview/download). */
export async function generateMarkdown(
  org: string,
  url: string,
  includeSubpages: boolean
): Promise<GenerateResult> {
  const access = typeof org === 'string' && org ? await getMemberAccess(org) : null;
  if (!access || !canViewArea(access, 'knowledge')) {
    return { ok: false, error: 'Keine Berechtigung für die Wissensdatenbank.' };
  }
  if (typeof url !== 'string' || url.trim().length === 0) {
    return { ok: false, error: 'Bitte eine URL angeben.' };
  }
  try {
    const result = await generateSiteMarkdown(url, includeSubpages === true);
    return { ok: true, ...result };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unbekannter Fehler';
    return { ok: false, error: `Erzeugung fehlgeschlagen: ${reason}` };
  }
}

const saveSchema = z.object({
  org: z.uuid(),
  knowledgeBaseId: z.uuid(),
  title: z.string().min(2).max(150),
  markdown: z.string().min(40).max(320_000),
});

function generatorUrl(org: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/tools/md-generator?${params.toString()}`;
}

/**
 * Stores the generated Markdown as a text source in the chosen knowledge base
 * (same storage/rollback flow as addTextSource — the worker indexes it like any
 * manual text, Markdown chunks cleanly).
 */
export async function saveMarkdownToKb(formData: FormData): Promise<void> {
  await requireAreaEdit(formData.get('org'), 'knowledge', (o) =>
    generatorUrl(o, { error: 'Keine Berechtigung für die Wissensdatenbank.' })
  );
  const parsed = saveSchema.safeParse({
    org: formData.get('org'),
    knowledgeBaseId: formData.get('knowledgeBaseId'),
    title: typeof formData.get('title') === 'string' ? (formData.get('title') as string).trim() : '',
    markdown: formData.get('markdown'),
  });
  if (!parsed.success) {
    redirect(
      generatorUrl(
        typeof formData.get('org') === 'string' ? (formData.get('org') as string) : '',
        { error: 'Bitte Titel und Wissensdatenbank prüfen (Inhalt max. 320.000 Zeichen).' }
      )
    );
  }
  const { org, knowledgeBaseId, title, markdown } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) redirect(generatorUrl(org, { error: 'Speicher ist serverseitig nicht konfiguriert.' }));

  const supabase = await createSupabaseServerClient();
  const { data: inserted, error } = await supabase
    .from('kb_sources')
    .insert({
      org_id: org,
      knowledge_base_id: knowledgeBaseId,
      type: 'text',
      uri: 'text',
      status: 'pending',
    })
    .select('id')
    .single();
  if (error || !inserted) {
    redirect(generatorUrl(org, { error: 'Quelle konnte nicht angelegt werden.' }));
  }
  const sourceId = (inserted as { id: string }).id;

  const body = `${title}\n\n${markdown}`;
  const { error: uploadError } = await admin.storage
    .from(KB_BUCKET)
    .upload(`${org}/${sourceId}/text.txt`, body, {
      contentType: 'text/plain; charset=utf-8',
      upsert: true,
    });
  if (uploadError) {
    await supabase.from('kb_sources').delete().eq('org_id', org).eq('id', sourceId);
    redirect(generatorUrl(org, { error: 'Inhalt konnte nicht gespeichert werden.' }));
  }

  // TOCTOU vs deleteKnowledgeBase (same guard as addTextSource)
  const { data: stillThere } = await supabase
    .from('kb_sources')
    .select('id')
    .eq('org_id', org)
    .eq('id', sourceId)
    .maybeSingle();
  if (!stillThere) {
    await admin.storage.from(KB_BUCKET).remove([`${org}/${sourceId}/text.txt`]);
    redirect(generatorUrl(org, { error: 'Quelle konnte nicht angelegt werden.' }));
  }

  revalidatePath('/settings/knowledge');
  redirect(
    `/settings/knowledge?${new URLSearchParams({
      org,
      notice: `„${title}" übernommen — die Indizierung startet in Kürze.`,
    }).toString()}`
  );
}
