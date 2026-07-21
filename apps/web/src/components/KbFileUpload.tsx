'use client';

import { useRef, useState, type DragEvent } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { finalizeKbUploads, prepareKbUploads } from '@/app/settings/knowledge/actions';

/**
 * Drag-and-drop multi-file uploader for knowledge-base sources. Files go
 * DIRECTLY from the browser to Supabase Storage via signed upload URLs —
 * routing bytes through a server action dies on Next's 1 MB action-body
 * default and Vercel's hard 4.5 MB function limit (prod crash 2026-07-21).
 * Flow: prepare (signed URLs) → uploadToSignedUrl per file → finalize
 * (creates the kb_sources rows and redirects with the notice).
 */

const ACCEPT = '.pdf,.docx,.txt,.md';
const MAX_BYTES = 15 * 1024 * 1024;
const KB_BUCKET = 'kb-files';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A stable-ish key for dedupe: same name + size = same pick. */
function fileKey(f: File): string {
  return `${f.name}:${f.size}`;
}

export default function KbFileUpload({
  org,
  knowledgeBaseId,
}: {
  org: string;
  knowledgeBaseId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addFiles(incoming: FileList | File[]): void {
    const seen = new Set(files.map(fileKey));
    const merged = [...files];
    for (const f of Array.from(incoming)) {
      if (!seen.has(fileKey(f))) {
        seen.add(fileKey(f));
        merged.push(f);
      }
    }
    setFiles(merged);
    setError(null);
  }

  function removeAt(index: number): void {
    setFiles(files.filter((_, i) => i !== index));
  }

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }

  async function upload(): Promise<void> {
    if (files.length === 0 || pending) return;
    setPending(true);
    setError(null);
    try {
      const prep = await prepareKbUploads(
        org,
        knowledgeBaseId,
        files.map((f) => ({ name: f.name, size: f.size }))
      );
      if (prep.error || !prep.uploads) {
        setError(prep.error ?? 'Upload konnte nicht vorbereitet werden.');
        return;
      }

      // prepare returns entries in the same order as the posted file list
      const supabase = createSupabaseBrowserClient();
      const uploaded: { path: string; filename: string }[] = [];
      let failed = 0;
      for (let i = 0; i < prep.uploads.length; i += 1) {
        const entry = prep.uploads[i]!;
        const file = files[i]!;
        const { error: uploadError } = await supabase.storage
          .from(KB_BUCKET)
          .uploadToSignedUrl(entry.path, entry.token, file);
        if (uploadError) failed += 1;
        else uploaded.push({ path: entry.path, filename: entry.filename });
      }
      if (uploaded.length === 0) {
        setError('Keine Datei konnte hochgeladen werden — bitte erneut versuchen.');
        return;
      }
      // finalize creates the sources and redirects with the success notice
      // (a partial client-side failure is reflected in the counts there).
      if (failed > 0) setError(`${failed} Datei(en) konnten nicht übertragen werden.`);
      await finalizeKbUploads(org, knowledgeBaseId, uploaded);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="stack" style={{ maxWidth: '32rem' }}>
      <div
        className={`kb-dropzone${dragActive ? ' kb-dropzone--active' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 16V4M8 8l4-4 4 4" />
          <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <span className="kb-dropzone-title">
          Dateien hierher ziehen oder <span className="kb-dropzone-link">durchsuchen</span>
        </span>
        <span className="kb-dropzone-hint">Mehrere Dateien möglich · PDF, DOCX, TXT, MD · max. 15 MB</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
            // allow re-picking the same file after removal
            e.target.value = '';
          }}
        />
      </div>

      {files.length > 0 ? (
        <ul className="kb-filelist">
          {files.map((f, i) => {
            const tooBig = f.size > MAX_BYTES;
            return (
              <li key={fileKey(f)} className="kb-fileitem">
                <span className="kb-fileitem-name" title={f.name}>
                  {f.name}
                </span>
                <span className={`kb-fileitem-size${tooBig ? ' kb-fileitem-size--bad' : ''}`}>
                  {formatBytes(f.size)}
                  {tooBig ? ' · zu groß' : ''}
                </span>
                <button
                  type="button"
                  className="kb-fileitem-remove"
                  aria-label={`${f.name} entfernen`}
                  onClick={() => removeAt(i)}
                  disabled={pending}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {error ? (
        <p className="error" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}

      <button
        className="primary"
        type="button"
        disabled={files.length === 0 || pending}
        onClick={() => void upload()}
      >
        {pending
          ? 'Wird hochgeladen…'
          : files.length === 0
            ? 'Datei hochladen'
            : files.length === 1
              ? '1 Datei hochladen'
              : `${files.length} Dateien hochladen`}
      </button>
    </div>
  );
}
