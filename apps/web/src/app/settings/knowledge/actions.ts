'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { parseQaCsv } from '@zendori/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { publicSupabaseEnv } from '@/lib/env';
import { requireAreaEdit } from '@/lib/access';

const KB_BUCKET = 'kb-files';
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_LENGTH = 100_000;
const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'csv'] as const;

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
  await requireAreaEdit(formData.get('org'), 'knowledge', (o) => knowledgeUrl(o, { error: 'Keine Berechtigung für diesen Bereich.' }));
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
  await requireAreaEdit(formData.get('org'), 'knowledge', (o) => knowledgeUrl(o, { error: 'Keine Berechtigung für diesen Bereich.' }));
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

// --- add Q&A CSV source ----------------------------------------------------------

/** Q&A CSVs are tiny; the cap keeps the action body safely under Next's 1 MB limit. */
const MAX_QA_CSV_BYTES = 800 * 1024;

const addQaCsvSchema = z.object({
  org: z.uuid(),
  knowledgeBaseId: z.uuid(),
});

/**
 * Imports a Q&A CSV (two columns: Frage;Antwort, optional header) as a file
 * source. The CSV is parsed HERE for immediate feedback (pair count / format
 * errors before anything is stored); the worker re-parses it at index time and
 * turns every pair into its own chunk. Storage/rollback mirrors addTextSource.
 */
export async function addQaCsvSource(formData: FormData): Promise<void> {
  await requireAreaEdit(formData.get('org'), 'knowledge', (o) => knowledgeUrl(o, { error: 'Keine Berechtigung für diesen Bereich.' }));
  const parsed = addQaCsvSchema.safeParse({
    org: formData.get('org'),
    knowledgeBaseId: formData.get('knowledgeBaseId'),
  });
  if (!parsed.success) {
    redirect(knowledgeUrl(textField(formData.get('org')), { error: 'Ungültige Anfrage.' }));
  }
  const { org, knowledgeBaseId } = parsed.data;

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(knowledgeUrl(org, { error: 'Bitte eine CSV-Datei auswählen.' }));
  }
  if (file.size > MAX_QA_CSV_BYTES) {
    redirect(knowledgeUrl(org, { error: 'CSV-Datei zu groß (max. 800 KB).' }));
  }
  const filename = sanitizeFilename(file.name);
  if (fileExtension(filename) !== 'csv') {
    redirect(knowledgeUrl(org, { error: 'Bitte eine .csv-Datei auswählen.' }));
  }

  const csvText = await file.text();
  const { pairs, skipped } = parseQaCsv(csvText);
  if (pairs.length === 0) {
    redirect(
      knowledgeUrl(org, {
        error:
          'Keine Frage-Antwort-Paare gefunden. Erwartetes Format: zwei Spalten „Frage;Antwort" (Semikolon oder Komma), optional mit Kopfzeile.',
      })
    );
  }

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
      type: 'file',
      uri: filename,
      status: 'pending',
    })
    .select('id')
    .single();
  if (error || !inserted) {
    redirect(knowledgeUrl(org, { error: 'Quelle konnte nicht angelegt werden.' }));
  }
  const sourceId = (inserted as { id: string }).id;

  const { error: uploadError } = await admin.storage
    .from(KB_BUCKET)
    .upload(`${org}/${sourceId}/${filename}`, csvText, {
      contentType: 'text/csv; charset=utf-8',
      upsert: true,
    });
  if (uploadError) {
    // roll back the orphaned row so it is not stuck 'pending' with no content
    await supabase.from('kb_sources').delete().eq('org_id', org).eq('id', sourceId);
    redirect(knowledgeUrl(org, { error: 'CSV konnte nicht gespeichert werden.' }));
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
    await admin.storage.from(KB_BUCKET).remove([`${org}/${sourceId}/${filename}`]);
    redirect(knowledgeUrl(org, { error: 'Quelle konnte nicht angelegt werden.' }));
  }

  revalidatePath('/settings/knowledge');
  const skippedSuffix =
    skipped > 0 ? ` (${skipped} ${skipped === 1 ? 'Zeile' : 'Zeilen'} übersprungen)` : '';
  redirect(
    knowledgeUrl(org, {
      notice: `${pairs.length} Frage-Antwort-Paare erkannt${skippedSuffix} — die Indizierung startet in Kürze.`,
    })
  );
}

// --- add file source -------------------------------------------------------------

// Files go DIRECTLY from the browser to Supabase Storage via signed upload
// URLs — a server action carrying file bytes dies on Next's 1 MB action-body
// default and Vercel's hard 4.5 MB function limit (prod crash 2026-07-21).
// prepare hands out signed URLs for a temp path; the client PUTs the bytes;
// finalize moves each file to its source path and creates the kb_sources rows.

const MAX_FILES_PER_BATCH = 20;

export interface PreparedUpload {
  /** Temp storage path the signed URL is bound to. */
  path: string;
  /** One-time upload token for uploadToSignedUrl. */
  token: string;
  /** Sanitized filename (client echoes it back to finalize). */
  filename: string;
  /** Original name, so the client can match File objects. */
  originalName: string;
}

const prepareUploadsSchema = z.object({
  org: z.uuid(),
  knowledgeBaseId: z.uuid(),
  files: z
    .array(z.object({ name: z.string().min(1).max(300), size: z.number().int().positive() }))
    .min(1)
    .max(MAX_FILES_PER_BATCH),
});

/**
 * Validates the batch and hands out one signed upload URL per file, bound to a
 * temp path under `<org>/uploads/…`. Membership is proven with a user-scoped
 * read of the target knowledge base BEFORE any service-role storage call.
 * Returns an error string instead of redirecting — the caller is imperative
 * client code, not a form post.
 */
export async function prepareKbUploads(
  org: string,
  knowledgeBaseId: string,
  files: { name: string; size: number }[]
): Promise<{ error?: string; uploads?: PreparedUpload[] }> {
  await requireAreaEdit(org, 'knowledge', (o) => knowledgeUrl(o, { error: 'Keine Berechtigung für diesen Bereich.' }));
  const parsed = prepareUploadsSchema.safeParse({ org, knowledgeBaseId, files });
  if (!parsed.success) {
    return { error: `Bitte 1–${MAX_FILES_PER_BATCH} Dateien auswählen.` };
  }

  const rejected: string[] = [];
  for (const file of parsed.data.files) {
    const ext = fileExtension(sanitizeFilename(file.name));
    if (file.size > MAX_FILE_BYTES) rejected.push(`${file.name} (zu groß, max. 15 MB)`);
    else if (!ALLOWED_EXTENSIONS.includes(ext as AllowedExtension))
      rejected.push(`${file.name} (Format nicht unterstützt)`);
  }
  if (rejected.length > 0) {
    return {
      error: `Nicht hochgeladen: ${rejected.join(', ')}. Erlaubt: PDF, DOCX, TXT, MD, CSV bis 15 MB.`,
    };
  }

  // Membership gate (RLS): only members see the knowledge base row.
  const supabase = await createSupabaseServerClient();
  const { data: kbRow } = await supabase
    .from('knowledge_bases')
    .select('id')
    .eq('org_id', parsed.data.org)
    .eq('id', parsed.data.knowledgeBaseId)
    .maybeSingle();
  if (!kbRow) return { error: 'Wissensdatenbank wurde nicht gefunden.' };

  const admin = createSupabaseAdminClient();
  if (!admin) return { error: 'Speicher ist serverseitig nicht konfiguriert.' };

  const uploads: PreparedUpload[] = [];
  for (const file of parsed.data.files) {
    const filename = sanitizeFilename(file.name);
    const path = `${parsed.data.org}/uploads/${crypto.randomUUID()}/${filename}`;
    const { data, error } = await admin.storage.from(KB_BUCKET).createSignedUploadUrl(path);
    if (error || !data) return { error: 'Upload konnte nicht vorbereitet werden.' };
    uploads.push({ path, token: data.token, filename, originalName: file.name });
  }
  return { uploads };
}

const finalizeUploadsSchema = z.object({
  org: z.uuid(),
  knowledgeBaseId: z.uuid(),
  uploads: z
    .array(z.object({ path: z.string().min(1).max(500), filename: z.string().min(1).max(300) }))
    .min(1)
    .max(MAX_FILES_PER_BATCH),
});

/**
 * Registers uploaded temp files as kb_sources: move to `<org>/<source_id>/…`
 * FIRST (pre-generated id — the worker must never see a pending source whose
 * file is not in place yet), then insert the row via the user-scoped client
 * (RLS + composite FK prove membership and org-match). Ends with the usual
 * redirect so the page shows the notice.
 */
export async function finalizeKbUploads(
  org: string,
  knowledgeBaseId: string,
  uploads: { path: string; filename: string }[]
): Promise<void> {
  await requireAreaEdit(org, 'knowledge', (o) => knowledgeUrl(o, { error: 'Keine Berechtigung für diesen Bereich.' }));
  const parsed = finalizeUploadsSchema.safeParse({ org, knowledgeBaseId, uploads });
  if (!parsed.success) {
    redirect(knowledgeUrl(typeof org === 'string' ? org : '', { error: 'Upload fehlgeschlagen.' }));
  }

  // Membership gate BEFORE any service-role storage op (§7).
  const supabase = await createSupabaseServerClient();
  const { data: kbRow } = await supabase
    .from('knowledge_bases')
    .select('id')
    .eq('org_id', parsed.data.org)
    .eq('id', parsed.data.knowledgeBaseId)
    .maybeSingle();
  if (!kbRow) {
    redirect(knowledgeUrl(parsed.data.org, { error: 'Wissensdatenbank wurde nicht gefunden.' }));
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    redirect(knowledgeUrl(parsed.data.org, { error: 'Speicher ist serverseitig nicht konfiguriert.' }));
  }

  // Temp paths must belong to THIS org's upload area — a forged path may not
  // reach into other tenants' files (prefix + strict charset, no traversal).
  const tempPathPattern = new RegExp(
    `^${parsed.data.org}/uploads/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9._-]+$`
  );

  const failures: string[] = [];
  let ok = 0;
  for (const upload of parsed.data.uploads) {
    const filename = sanitizeFilename(upload.filename);
    const ext = fileExtension(filename);
    if (!tempPathPattern.test(upload.path) || !ALLOWED_EXTENSIONS.includes(ext as AllowedExtension)) {
      failures.push(filename);
      continue;
    }
    const sourceId = crypto.randomUUID();
    const finalPath = `${parsed.data.org}/${sourceId}/${filename}`;
    const { error: moveError } = await admin.storage.from(KB_BUCKET).move(upload.path, finalPath);
    if (moveError) {
      failures.push(filename);
      continue;
    }
    const { error: insertError } = await supabase.from('kb_sources').insert({
      id: sourceId,
      org_id: parsed.data.org,
      knowledge_base_id: parsed.data.knowledgeBaseId,
      type: 'file',
      uri: filename,
      status: 'pending',
    });
    if (insertError) {
      // membership/kb gone mid-flight — remove the moved file again
      await admin.storage.from(KB_BUCKET).remove([finalPath]);
      failures.push(filename);
      continue;
    }
    ok += 1;
  }

  revalidatePath('/settings/knowledge');
  if (ok === 0) {
    redirect(knowledgeUrl(parsed.data.org, { error: 'Keine Datei konnte hochgeladen werden.' }));
  }
  const noticeCount = ok === 1 ? 'Datei hochgeladen' : `${ok} Dateien hochgeladen`;
  const suffix = failures.length > 0 ? ` (${failures.length} fehlgeschlagen)` : '';
  redirect(
    knowledgeUrl(parsed.data.org, {
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
  await requireAreaEdit(formData.get('org'), 'knowledge', (o) => knowledgeUrl(o, { error: 'Keine Berechtigung für diesen Bereich.' }));
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
  await requireAreaEdit(formData.get('org'), 'knowledge', (o) => knowledgeUrl(o, { error: 'Keine Berechtigung für diesen Bereich.' }));
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
  await requireAreaEdit(formData.get('org'), 'knowledge', (o) => knowledgeUrl(o, { error: 'Keine Berechtigung für diesen Bereich.' }));
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
  await requireAreaEdit(formData.get('org'), 'knowledge', (o) => knowledgeUrl(o, { error: 'Keine Berechtigung für diesen Bereich.' }));
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
