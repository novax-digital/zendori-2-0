// Attaching released knowledge-base files to a bot reply (migration 0025).
//
// The decision costs NO extra model call. The draft model already reports which
// sources it used (DraftResult.used_source_ids, packages/ai/src/schemas.ts), so
// "which file, if any, belongs on this reply" is a plain database lookup over an
// answer we already have. Everything expensive about images — looking at them,
// describing them — happened once at index time.
//
// Two gates, both narrow on purpose:
//   1. the answer actually used that source (no guessing from raw similarity), and
//   2. an owner released that source for sending (kb_sources.is_shareable).
//
// Both must hold. A source that informed the answer but was never released stays
// inside the org; a released source that had nothing to do with this answer is
// not sent either.
import {
  MAX_OUTBOUND_ATTACHMENTS,
  MAX_OUTBOUND_ATTACHMENTS_TOTAL_BYTES,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  mimeForFilename,
  sniffImageMime,
  type SupabaseClient,
} from '@zendori/core';

const KB_BUCKET = 'kb-files';
const ATTACHMENT_BUCKET = 'attachments';

/** A released file, resolved but not yet fetched. */
export interface ReleasedFile {
  sourceId: string;
  filename: string;
  /** Path inside the private `kb-files` bucket. */
  storagePath: string;
}

/** A released file whose bytes are in hand, ready to attach and deliver. */
export interface LoadedFile extends ReleasedFile {
  bytes: Buffer;
  /** Verified from the magic bytes for images, derived from the name otherwise. */
  mime: string;
}

/**
 * A file that made it into the `attachments` bucket. `storagePath` now points
 * there (not at kb-files) and the bytes are kept so the email path can inline
 * them without a second download.
 */
export interface AttachedFile extends LoadedFile {
  storagePath: string;
}

/**
 * Which of the sources this answer used are released for sending?
 *
 * Returns [] for anything that should never carry a file — that includes the
 * pre-0025 schema (42703), so a worker running ahead of the migration simply
 * sends text.
 */
export async function resolveReleasedFiles(
  supabase: SupabaseClient,
  params: { orgId: string; usedSourceIds: string[] }
): Promise<ReleasedFile[]> {
  const ids = Array.from(new Set(params.usedSourceIds.filter((id) => id.length > 0)));
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from('kb_sources')
    .select('id, uri')
    .eq('org_id', params.orgId)
    .eq('type', 'file')
    .eq('is_shareable', true)
    // A source mid-reindex may have no chunks matching its file yet.
    .eq('status', 'indexed')
    .in('id', ids)
    .limit(MAX_OUTBOUND_ATTACHMENTS);
  if (error) return [];

  return ((data ?? []) as { id: string; uri: string | null }[])
    .filter((row): row is { id: string; uri: string } => (row.uri ?? '').length > 0)
    .map((row) => ({
      sourceId: row.id,
      filename: row.uri,
      storagePath: `${params.orgId}/${row.id}/${row.uri}`,
    }));
}

/**
 * Fetch the bytes for released files, dropping any that are missing or over the
 * per-message caps. Never throws: a reply must never fail because of an
 * attachment.
 *
 * Images get their real media type from the magic bytes rather than the filename,
 * so a mislabelled file cannot later be rendered inline by a recipient (or by our
 * own inbox) as something it is not.
 */
export async function loadReleasedFiles(
  supabase: SupabaseClient,
  files: ReleasedFile[]
): Promise<LoadedFile[]> {
  const loaded: LoadedFile[] = [];
  let total = 0;
  for (const file of files) {
    try {
      const { data, error } = await supabase.storage.from(KB_BUCKET).download(file.storagePath);
      if (error || !data) continue;
      const bytes = Buffer.from(await data.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_OUTBOUND_ATTACHMENT_BYTES) continue;
      if (total + bytes.byteLength > MAX_OUTBOUND_ATTACHMENTS_TOTAL_BYTES) continue;
      total += bytes.byteLength;
      loaded.push({
        ...file,
        bytes,
        mime: sniffImageMime(bytes) ?? mimeForFilename(file.filename),
      });
    } catch {
      // Skip this file; the text reply still goes out.
    }
  }
  return loaded;
}

/**
 * Copy the bytes into the `attachments` bucket under the outbound message and
 * record the `attachments` rows. Returns the storage paths that succeeded.
 *
 * Copying rather than referencing kb-files is deliberate: the existing storage
 * policy scopes access by the first path segment (org id), every reader in the
 * codebase hardcodes the `attachments` bucket, and a later deletion of the
 * knowledge source then cannot break the record of what was already sent to a
 * customer.
 *
 * Precedent for attaching to an outbound row: the voice post-call job attaches
 * its recording to a direction='out' message the same way.
 */
export async function persistOutboundAttachments(
  supabase: SupabaseClient,
  params: { orgId: string; messageId: string; files: LoadedFile[] }
): Promise<AttachedFile[]> {
  const stored: AttachedFile[] = [];
  for (const file of params.files) {
    const storagePath = `${params.orgId}/${params.messageId}/${file.filename}`;
    try {
      const up = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .upload(storagePath, file.bytes, { contentType: file.mime, upsert: true });
      if (up.error) continue;
      const ins = await supabase.from('attachments').insert({
        org_id: params.orgId,
        message_id: params.messageId,
        storage_path: storagePath,
        mime: file.mime,
        size: file.bytes.byteLength,
      });
      if (ins.error) continue;
      stored.push({ ...file, storagePath });
    } catch {
      // Skip this file; the text reply still goes out.
    }
  }
  return stored;
}
