'use client';

import { useRef, useState, type DragEvent } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * Drag-and-drop multi-file uploader for knowledge-base sources. Keeps a hidden
 * `<input type="file" multiple>` in sync with the picked/dropped files (via a
 * rebuilt DataTransfer) so a plain form submit posts every file under `file` —
 * the server action reads them with formData.getAll('file'). No client fetch:
 * progressive-enhancement-friendly, one server round-trip.
 */

const ACCEPT = '.pdf,.docx,.txt,.md';
const MAX_BYTES = 15 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A stable-ish key for dedupe: same name + size = same pick. */
function fileKey(f: File): string {
  return `${f.name}:${f.size}`;
}

function SubmitButton({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <button className="primary" type="submit" disabled={count === 0 || pending}>
      {pending
        ? 'Wird hochgeladen…'
        : count === 0
          ? 'Datei hochladen'
          : count === 1
            ? '1 Datei hochladen'
            : `${count} Dateien hochladen`}
    </button>
  );
}

export default function KbFileUpload({
  org,
  knowledgeBaseId,
  action,
}: {
  org: string;
  knowledgeBaseId: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);

  // Mirror the current file list back into the real input so the form submit
  // carries them (input.files is not directly assignable — use DataTransfer).
  function sync(next: File[]): void {
    setFiles(next);
    if (inputRef.current) {
      const dt = new DataTransfer();
      next.forEach((f) => dt.items.add(f));
      inputRef.current.files = dt.files;
    }
  }

  function addFiles(incoming: FileList | File[]): void {
    const seen = new Set(files.map(fileKey));
    const merged = [...files];
    for (const f of Array.from(incoming)) {
      if (!seen.has(fileKey(f))) {
        seen.add(fileKey(f));
        merged.push(f);
      }
    }
    sync(merged);
  }

  function removeAt(index: number): void {
    sync(files.filter((_, i) => i !== index));
  }

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }

  return (
    <form className="stack" action={action} style={{ maxWidth: '32rem' }}>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="knowledgeBaseId" value={knowledgeBaseId} />

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
          name="file"
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
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
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <SubmitButton count={files.length} />
    </form>
  );
}
