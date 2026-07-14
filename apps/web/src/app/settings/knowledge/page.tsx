import type { CSSProperties, ReactNode } from 'react';
import type { KbSourceStatus, KbSourceType } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import KnowledgeTabs, { type KbTabKey } from '@/components/KnowledgeTabs';
import { addFileSource, addTextSource, addUrlSource, deleteSource, reindexSource } from './actions';

type KbSourceRow = {
  id: string;
  type: KbSourceType;
  uri: string | null;
  status: KbSourceStatus;
  last_indexed_at: string | null;
  created_at: string;
};

const typeLabels: Record<KbSourceType, string> = {
  url: 'URL',
  file: 'Datei',
  text: 'Text',
};

const statusLabels: Record<KbSourceStatus, string> = {
  pending: 'Ausstehend',
  indexed: 'Indiziert',
  error: 'Fehler',
};

// theme-token backed so the badges stay legible in dark mode
const statusStyles: Record<KbSourceStatus, CSSProperties> = {
  pending: { background: 'var(--warn-tint)', color: 'var(--warn)' },
  indexed: { background: 'var(--success-tint)', color: 'var(--success-ink)' },
  error: { background: 'var(--danger-tint)', color: 'var(--danger)' },
};

const textareaStyle: CSSProperties = {
  width: '100%',
  padding: '0.55rem 0.75rem',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: '0.95rem',
  fontFamily: 'inherit',
  background: 'var(--surface)',
  resize: 'vertical',
};

const helpStyle: CSSProperties = {
  fontSize: '0.9rem',
  color: 'var(--text-muted)',
  marginBottom: '1.25rem',
};

function statusBadge(status: KbSourceStatus) {
  return (
    <span className="badge" style={statusStyles[status]}>
      {statusLabels[status]}
    </span>
  );
}

/** Human label for a source (URL / uploaded filename / generic text). */
function sourceLabel(source: KbSourceRow): string {
  if (source.type === 'text') return 'Manueller Text';
  return source.uri ?? '—';
}

/** Server-rendered coarse relative time (German), good enough for an index list. */
function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMin = Math.round((Date.now() - then) / 60_000);
  if (diffMin < 1) return 'gerade eben';
  if (diffMin < 60) return `vor ${diffMin} Min.`;
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) return `vor ${diffHours} Std.`;
  const diffDays = Math.round(diffHours / 24);
  return `vor ${diffDays} ${diffDays === 1 ? 'Tag' : 'Tagen'}`;
}

async function listKbSources(orgId: string): Promise<KbSourceRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('kb_sources')
    .select('id, type, uri, status, last_indexed_at, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  return (data ?? []) as unknown as KbSourceRow[];
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, orgs } = await requireActiveOrg(org);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const sources = await listKbSources(orgId);

  const urlPanel: ReactNode = (
    <>
      <p style={helpStyle}>
        Eine Webseite oder Sitemap (.xml). Bei einer Sitemap werden bis zu 20 verlinkte Seiten
        eingelesen.
      </p>
      <form className="stack" action={addUrlSource} style={{ maxWidth: '32rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <div>
          <label htmlFor="url">URL</label>
          <input id="url" name="url" type="url" required placeholder="https://www.beispiel.de/hilfe" />
        </div>
        <button className="primary" type="submit">
          URL hinzufügen
        </button>
      </form>
    </>
  );

  const filePanel: ReactNode = (
    <>
      <p style={helpStyle}>
        PDF, DOCX, TXT oder MD, maximal 15 MB. Der Text wird aus der Datei extrahiert und indiziert.
      </p>
      <form className="stack" action={addFileSource} style={{ maxWidth: '32rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <div>
          <label htmlFor="file">Datei</label>
          <input id="file" name="file" type="file" accept=".pdf,.docx,.txt,.md" required />
        </div>
        <button className="primary" type="submit">
          Datei hochladen
        </button>
      </form>
    </>
  );

  const textPanel: ReactNode = (
    <>
      <p style={helpStyle}>
        Ein manuell gepflegter Text — z. B. Rückgabebedingungen, FAQ-Antworten oder interne
        Hinweise, die der KI-Agent kennen soll.
      </p>
      <form className="stack" action={addTextSource} style={{ maxWidth: '32rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <div>
          <label htmlFor="title">Titel</label>
          <input
            id="title"
            name="title"
            type="text"
            required
            minLength={1}
            maxLength={200}
            placeholder="z. B. Rückgabebedingungen"
          />
        </div>
        <div>
          <label htmlFor="text">Text</label>
          <textarea id="text" name="text" rows={6} required style={textareaStyle} />
        </div>
        <button className="primary" type="submit">
          Text hinzufügen
        </button>
      </form>
    </>
  );

  const tabs: { key: KbTabKey; label: string; panel: ReactNode }[] = [
    { key: 'url', label: 'URL', panel: urlPanel },
    { key: 'file', label: 'Datei', panel: filePanel },
    { key: 'text', label: 'Text', panel: textPanel },
  ];

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Wissensdatenbank</h1>
        <p>
          Quellen von {orgName} werden im Hintergrund verarbeitet (Zerlegung in Abschnitte,
          Embeddings) und dienen dem KI-Agenten als Grundlage für Antwortvorschläge. Neue Quellen
          starten als „Ausstehend" und wechseln nach der Indizierung auf „Indiziert".
        </p>
      </div>

      {error ? (
        <p className="error" style={{ marginBottom: '1.5rem' }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" style={{ marginBottom: '1.5rem' }}>
          {notice}
        </p>
      ) : null}

      <div className="panel">
        <h2>Quellen</h2>
        {sources.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Noch keine Quellen vorhanden. Füge unten eine URL, eine Datei oder einen Text hinzu.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Typ</th>
                <th>Quelle</th>
                <th>Status</th>
                <th>Zuletzt indiziert</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td>{typeLabels[source.type]}</td>
                  <td style={{ wordBreak: 'break-all' }}>{sourceLabel(source)}</td>
                  <td>{statusBadge(source.status)}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    {formatRelative(source.last_indexed_at)}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <form
                      action={reindexSource}
                      style={{ display: 'inline-block', marginRight: '0.4rem' }}
                    >
                      <input type="hidden" name="org" value={orgId} />
                      <input type="hidden" name="id" value={source.id} />
                      <button className="ghost" type="submit">
                        Neu indizieren
                      </button>
                    </form>
                    <form action={deleteSource} style={{ display: 'inline-block' }}>
                      <input type="hidden" name="org" value={orgId} />
                      <input type="hidden" name="id" value={source.id} />
                      <button className="ghost" type="submit">
                        Löschen
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <KnowledgeTabs tabs={tabs} />
    </div>
  );
}
