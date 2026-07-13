'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

const KB_BUCKET = 'kb-files';
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_LENGTH = 100_000;
const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'txt', 'md'] as const;

type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function knowledgeUrl(org: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/settings/knowledge?${params.toString()}`;
}

/** Basename, restricted to a safe charset so it can never escape the org/source prefix. */
function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'datei';
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// --- add URL source --------------------------------------------------------------

const addUrlSchema = z.object({
  org: z.uuid(),
  url: z.url().max(2000),
});

export async function addUrlSource(formData: FormData): Promise<void> {
  const parsed = addUrlSchema.safeParse({
    org: formData.get('org'),
    url: textField(formData.get('url')),
  });
  if (!parsed.success) {
    redirect(
      knowledgeUrl(textField(formData.get('org')), {
        error: 'Bitte eine gültige URL (http/https) angeben.',
      })
    );
  }
  const { org, url } = parsed.data;
  // reject non-web schemes (javascript:, data:, file: …) before we ever crawl it
  if (!/^https?:\/\//i.test(url)) {
    redirect(knowledgeUrl(org, { error: 'Bitte eine gültige URL (http/https) angeben.' }));
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('kb_sources')
    .insert({ org_id: org, type: 'url', uri: url, status: 'pending' });
  if (error) {
    redirect(knowledgeUrl(org, { error: 'Quelle konnte nicht angelegt werden.' }));
  }

  revalidatePath('/settings/knowledge');
  redirect(
    knowledgeUrl(org, { notice: 'URL-Quelle angelegt — die Indizierung startet in Kürze.' })
  );
}

// --- add manual text source ------------------------------------------------------

const addTextSchema = z.object({
  org: z.uuid(),
  title: z.string().min(1).max(200),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
});

/**
 * Creates a text source and stores its content as a file so the worker indexes
 * text/file/url uniformly (contract: manual text lives at <org>/<source_id>/text.txt,
 * uri = 'text'). The title is prepended to the body so it becomes searchable context.
 */
export async function addTextSource(formData: FormData): Promise<void> {
  const rawText = formData.get('text');
  const parsed = addTextSchema.safeParse({
    org: formData.get('org'),
    title: textField(formData.get('title')),
    text: typeof rawText === 'string' ? rawText : '',
  });
  if (!parsed.success) {
    redirect(
      knowledgeUrl(textField(formData.get('org')), {
        error: 'Bitte einen Titel und einen Text (max. 100.000 Zeichen) angeben.',
      })
    );
  }
  const { org, title, text } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(knowledgeUrl(org, { error: 'Speicher ist serverseitig nicht konfiguriert.' }));
  }

  const supabase = await createSupabaseServerClient();
  const { data: inserted, error } = await supabase
    .from('kb_sources')
    .insert({ org_id: org, type: 'text', uri: 'text', status: 'pending' })
    .select('id')
    .single();
  if (error || !inserted) {
    redirect(knowledgeUrl(org, { error: 'Quelle konnte nicht angelegt werden.' }));
  }
  const sourceId = (inserted as { id: string }).id;

  const body = `${title}\n\n${text}`;
  const { error: uploadError } = await admin.storage
    .from(KB_BUCKET)
    .upload(`${org}/${sourceId}/text.txt`, body, {
      contentType: 'text/plain; charset=utf-8',
      upsert: true,
    });
  if (uploadError) {
    // roll back the orphaned row so it is not stuck 'pending' with no content
    await supabase.from('kb_sources').delete().eq('org_id', org).eq('id', sourceId);
    redirect(knowledgeUrl(org, { error: 'Text konnte nicht gespeichert werden.' }));
  }

  revalidatePath('/settings/knowledge');
  redirect(
    knowledgeUrl(org, { notice: 'Text-Quelle angelegt — die Indizierung startet in Kürze.' })
  );
}

// --- add file source -------------------------------------------------------------

const addFileMetaSchema = z.object({ org: z.uuid() });

export async function addFileSource(formData: FormData): Promise<void> {
  const parsedMeta = addFileMetaSchema.safeParse({ org: formData.get('org') });
  if (!parsedMeta.success) {
    redirect(
      knowledgeUrl(textField(formData.get('org')), {
        error: 'Organisation wurde nicht gefunden.',
      })
    );
  }
  const { org } = parsedMeta.data;

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(knowledgeUrl(org, { error: 'Bitte eine Datei auswählen.' }));
  }
  if (file.size > MAX_FILE_BYTES) {
    redirect(knowledgeUrl(org, { error: 'Die Datei ist zu groß (max. 15 MB).' }));
  }
  const filename = sanitizeFilename(file.name);
  const ext = fileExtension(filename);
  if (!ALLOWED_EXTENSIONS.includes(ext as AllowedExtension)) {
    redirect(
      knowledgeUrl(org, { error: 'Nicht unterstütztes Format. Erlaubt: PDF, DOCX, TXT, MD.' })
    );
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(knowledgeUrl(org, { error: 'Speicher ist serverseitig nicht konfiguriert.' }));
  }

  const supabase = await createSupabaseServerClient();
  const { data: inserted, error } = await supabase
    .from('kb_sources')
    .insert({ org_id: org, type: 'file', uri: filename, status: 'pending' })
    .select('id')
    .single();
  if (error || !inserted) {
    redirect(knowledgeUrl(org, { error: 'Quelle konnte nicht angelegt werden.' }));
  }
  const sourceId = (inserted as { id: string }).id;

  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: uploadError } = await admin.storage
    .from(KB_BUCKET)
    .upload(`${org}/${sourceId}/${filename}`, buffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: true,
    });
  if (uploadError) {
    await supabase.from('kb_sources').delete().eq('org_id', org).eq('id', sourceId);
    redirect(knowledgeUrl(org, { error: 'Datei konnte nicht hochgeladen werden.' }));
  }

  revalidatePath('/settings/knowledge');
  redirect(knowledgeUrl(org, { notice: 'Datei hochgeladen — die Indizierung startet in Kürze.' }));
}

// --- reindex / delete ------------------------------------------------------------

const rowActionSchema = z.object({ org: z.uuid(), id: z.uuid() });

export async function reindexSource(formData: FormData): Promise<void> {
  const parsed = rowActionSchema.safeParse({
    org: formData.get('org'),
    id: formData.get('id'),
  });
  if (!parsed.success) {
    redirect(
      knowledgeUrl(textField(formData.get('org')), {
        error: 'Quelle konnte nicht neu indiziert werden.',
      })
    );
  }
  const { org, id } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('kb_sources')
    .update({ status: 'pending' })
    .eq('org_id', org)
    .eq('id', id)
    .select('id');
  if (error || !data || data.length === 0) {
    redirect(knowledgeUrl(org, { error: 'Quelle konnte nicht neu indiziert werden.' }));
  }

  revalidatePath('/settings/knowledge');
  redirect(knowledgeUrl(org, { notice: 'Neuindizierung gestartet.' }));
}

export async function deleteSource(formData: FormData): Promise<void> {
  const parsed = rowActionSchema.safeParse({
    org: formData.get('org'),
    id: formData.get('id'),
  });
  if (!parsed.success) {
    redirect(
      knowledgeUrl(textField(formData.get('org')), {
        error: 'Quelle konnte nicht gelöscht werden.',
      })
    );
  }
  const { org, id } = parsed.data;

  const supabase = await createSupabaseServerClient();

  // Delete the source with the *user-scoped* client FIRST: RLS proves the caller
  // is a member of `org`, and the FK cascade removes the source's kb_chunks. Only
  // after exactly one row is removed do we touch service-role storage — otherwise
  // a forged org/id could reach another tenant's files. (§7 tenant isolation.)
  const { data: deleted, error } = await supabase
    .from('kb_sources')
    .delete()
    .eq('org_id', org)
    .eq('id', id)
    .select('id');
  if (error || !deleted || deleted.length === 0) {
    redirect(knowledgeUrl(org, { error: 'Quelle konnte nicht gelöscht werden.' }));
  }

  // Membership proven → clean up stored files + any residual chunks (best effort).
  const admin = createSupabaseAdminClient();
  if (admin) {
    await admin.from('kb_chunks').delete().eq('org_id', org).eq('source_id', id);
    const { data: listed } = await admin.storage.from(KB_BUCKET).list(`${org}/${id}`);
    if (listed && listed.length > 0) {
      await admin.storage
        .from(KB_BUCKET)
        .remove(listed.map((entry) => `${org}/${id}/${entry.name}`));
    }
  }

  revalidatePath('/settings/knowledge');
  redirect(knowledgeUrl(org, { notice: 'Quelle gelöscht.' }));
}
