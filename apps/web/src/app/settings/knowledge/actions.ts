'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { publicSupabaseEnv } from '@/lib/env';

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

/**
 * Verifies the caller re-entered their own current password — a deliberate gate
 * for destructive actions (§8.2 spirit). Uses a THROWAWAY client with session
 * persistence off, so a successful sign-in never rotates the real session cookie.
 * Returns true only when email + password authenticate.
 */
async function verifyCurrentPassword(email: string, password: string): Promise<boolean> {
  if (!email || password.length === 0) return false;
  const { url, anonKey } = publicSupabaseEnv();
  const throwaway = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await throwaway.auth.signInWithPassword({ email, password });
  return !error;
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
  knowledgeBaseId: z.uuid(),
  url: z.url().max(2000),
});

export async function addUrlSource(formData: FormData): Promise<void> {
  const parsed = addUrlSchema.safeParse({
    org: formData.get('org'),
    knowledgeBaseId: formData.get('knowledgeBaseId'),
    url: textField(formData.get('url')),
  });
  if (!parsed.success) {
    redirect(
      knowledgeUrl(textField(formData.get('org')), {
        error: 'Bitte eine gültige URL (http/https) angeben.',
      })
    );
  }
  const { org, knowledgeBaseId, url } = parsed.data;
  // reject non-web schemes (javascript:, data:, file: …) before we ever crawl it
  if (!/^https?:\/\//i.test(url)) {
    redirect(knowledgeUrl(org, { error: 'Bitte eine gültige URL (http/https) angeben.' }));
  }

  const supabase = await createSupabaseServerClient();
  // the composite FK rejects a knowledgeBaseId belonging to another org
  const { error } = await supabase
    .from('kb_sources')
    .insert({ org_id: org, knowledge_base_id: knowledgeBaseId, type: 'url', uri: url, status: 'pending' });
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
  knowledgeBaseId: z.uuid(),
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
    knowledgeBaseId: formData.get('knowledgeBaseId'),
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
  const { org, knowledgeBaseId, title, text } = parsed.data;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(knowledgeUrl(org, { error: 'Speicher ist serverseitig nicht konfiguriert.' }));
  }

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

  // TOCTOU vs deleteKnowledgeBase: if the base (and via cascade this row) was
  // deleted mid-upload, remove the just-uploaded file instead of orphaning it.
  const { data: stillThere } = await supabase
    .from('kb_sources')
    .select('id')
    .eq('org_id', org)
    .eq('id', sourceId)
    .maybeSingle();
  if (!stillThere) {
    await admin.storage.from(KB_BUCKET).remove([`${org}/${sourceId}/text.txt`]);
    redirect(knowledgeUrl(org, { error: 'Quelle konnte nicht angelegt werden.' }));
  }

  revalidatePath('/settings/knowledge');
  redirect(
    knowledgeUrl(org, { notice: 'Text-Quelle angelegt — die Indizierung startet in Kürze.' })
  );
}

// --- add file source -------------------------------------------------------------

const addFileMetaSchema = z.object({ org: z.uuid(), knowledgeBaseId: z.uuid() });

/** Uploads a single already-validated file as its own source. Returns the failed filename, or null on success. */
async function uploadOneFile(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  org: string,
  knowledgeBaseId: string,
  file: File
): Promise<string | null> {
  const filename = sanitizeFilename(file.name);
  const { data: inserted, error } = await supabase
    .from('kb_sources')
    .insert({
      org_id: org,
      knowledge_base_id: knowledgeBaseId,
      type: 'file',
      uri: filename,
      status: 'pending',
    })
    .select('id')
    .single();
  if (error || !inserted) return filename;
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
    return filename;
  }

  // TOCTOU vs deleteKnowledgeBase (see addTextSource).
  const { data: stillThere } = await supabase
    .from('kb_sources')
    .select('id')
    .eq('org_id', org)
    .eq('id', sourceId)
    .maybeSingle();
  if (!stillThere) {
    await admin.storage.from(KB_BUCKET).remove([`${org}/${sourceId}/${filename}`]);
    return filename;
  }
  return null;
}

export async function addFileSource(formData: FormData): Promise<void> {
  const parsedMeta = addFileMetaSchema.safeParse({
    org: formData.get('org'),
    knowledgeBaseId: formData.get('knowledgeBaseId'),
  });
  if (!parsedMeta.success) {
    redirect(
      knowledgeUrl(textField(formData.get('org')), {
        error: 'Organisation wurde nicht gefunden.',
      })
    );
  }
  const { org, knowledgeBaseId } = parsedMeta.data;

  // Multi-file: the uploader posts every picked/dropped file under `file`.
  const files = formData.getAll('file').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    redirect(knowledgeUrl(org, { error: 'Bitte mindestens eine Datei auswählen.' }));
  }

  // Validate all up front — reject the whole batch on a bad file so nothing is
  // silently dropped (the user picked it on purpose).
  const rejected: string[] = [];
  for (const file of files) {
    const ext = fileExtension(sanitizeFilename(file.name));
    if (file.size > MAX_FILE_BYTES) rejected.push(`${file.name} (zu groß, max. 15 MB)`);
    else if (!ALLOWED_EXTENSIONS.includes(ext as AllowedExtension))
      rejected.push(`${file.name} (Format nicht unterstützt)`);
  }
  if (rejected.length > 0) {
    redirect(
      knowledgeUrl(org, {
        error: `Nicht hochgeladen: ${rejected.join(', ')}. Erlaubt: PDF, DOCX, TXT, MD bis 15 MB.`,
      })
    );
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(knowledgeUrl(org, { error: 'Speicher ist serverseitig nicht konfiguriert.' }));
  }

  const supabase = await createSupabaseServerClient();
  const failures: string[] = [];
  for (const file of files) {
    const failed = await uploadOneFile(supabase, admin, org, knowledgeBaseId, file);
    if (failed) failures.push(failed);
  }

  const ok = files.length - failures.length;
  revalidatePath('/settings/knowledge');
  if (ok === 0) {
    redirect(knowledgeUrl(org, { error: 'Keine Datei konnte hochgeladen werden.' }));
  }
  const noticeCount = ok === 1 ? 'Datei hochgeladen' : `${ok} Dateien hochgeladen`;
  const suffix = failures.length > 0 ? ` (${failures.length} fehlgeschlagen)` : '';
  redirect(
    knowledgeUrl(org, {
      notice: `${noticeCount}${suffix} — die Indizierung startet in Kürze.`,
    })
  );
}

// --- knowledge bases (0012) --------------------------------------------------------

const createKbSchema = z.object({
  org: z.uuid(),
  name: z.string().min(2).max(80),
  description: z.string().max(300),
});

/** Creates a knowledge base (member-level content management, like sources). */
export async function createKnowledgeBase(formData: FormData): Promise<void> {
  const parsed = createKbSchema.safeParse({
    org: formData.get('org'),
    name: textField(formData.get('name')),
    description: textField(formData.get('description')),
  });
  if (!parsed.success) {
    redirect(
      knowledgeUrl(textField(formData.get('org')), {
        error: 'Bitte einen Namen (2–80 Zeichen) angeben.',
      })
    );
  }
  const { org, name, description } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('knowledge_bases').insert({
    org_id: org,
    name,
    description: description === '' ? null : description,
  });
  if (error) {
    redirect(knowledgeUrl(org, { error: 'Wissensdatenbank konnte nicht angelegt werden.' }));
  }

  revalidatePath('/settings/knowledge');
  redirect(knowledgeUrl(org, { notice: `Wissensdatenbank „${name}" angelegt.` }));
}

const deleteKbSchema = z.object({
  org: z.uuid(),
  id: z.uuid(),
  password: z.string().min(1),
});

/**
 * Deletes a knowledge base INCLUDING all its sources and chunks (FK cascade).
 * Guarded by a current-password re-entry (irreversible action). Mirrors
 * deleteSource's isolation pattern: the user-scoped delete proves membership
 * before any service-role storage cleanup runs (§7).
 */
export async function deleteKnowledgeBase(formData: FormData): Promise<void> {
  const parsed = deleteKbSchema.safeParse({
    org: formData.get('org'),
    id: formData.get('id'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    redirect(
      knowledgeUrl(textField(formData.get('org')), {
        error: 'Bitte zur Bestätigung dein aktuelles Passwort eingeben.',
      })
    );
  }
  const { org, id, password } = parsed.data;

  const supabase = await createSupabaseServerClient();

  // Password gate: prove it is really the account owner before an irreversible
  // delete. Reuses the signed-in user's email; only the password comes from the form.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !(await verifyCurrentPassword(user.email, password))) {
    redirect(knowledgeUrl(org, { error: 'Falsches Passwort — Löschung abgebrochen.' }));
  }

  // Collect the source ids BEFORE the cascade removes them (user-scoped: RLS
  // proves membership; a foreign org/id yields zero rows and a harmless no-op).
  const { data: sourceRows } = await supabase
    .from('kb_sources')
    .select('id')
    .eq('org_id', org)
    .eq('knowledge_base_id', id);
  const sourceIds = ((sourceRows ?? []) as { id: string }[]).map((r) => r.id);

  const { data: deleted, error } = await supabase
    .from('knowledge_bases')
    .delete()
    .eq('org_id', org)
    .eq('id', id)
    .select('id');
  if (error || !deleted || deleted.length === 0) {
    redirect(knowledgeUrl(org, { error: 'Wissensdatenbank konnte nicht gelöscht werden.' }));
  }

  // Membership proven → best-effort cleanup of stored files per source.
  const admin = createSupabaseAdminClient();
  if (admin) {
    for (const sourceId of sourceIds) {
      const { data: listed } = await admin.storage.from(KB_BUCKET).list(`${org}/${sourceId}`);
      if (listed && listed.length > 0) {
        await admin.storage
          .from(KB_BUCKET)
          .remove(listed.map((entry) => `${org}/${sourceId}/${entry.name}`));
      }
    }
  }

  revalidatePath('/settings/knowledge');
  revalidatePath('/settings/agents');
  redirect(knowledgeUrl(org, { notice: 'Wissensdatenbank samt Quellen gelöscht.' }));
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
