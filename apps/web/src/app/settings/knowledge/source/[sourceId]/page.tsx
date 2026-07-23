// Chunk transparency view: shows VERBATIM what is indexed for one kb_source —
// every Textbaustein exactly as the AI retrieves it (incl. the "Quelle: …"
// provenance header). Owner-facing traceability for the knowledge base; RLS
// scopes every query to the caller's org.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { KbSourceStatus, KbSourceType } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const PAGE_SIZE = 50;

type SourceRow = {
  id: string;
  type: KbSourceType;
  uri: string | null;
  status: KbSourceStatus;
  last_indexed_at: string | null;
  knowledge_base: { name: string } | null;
};

type ChunkRow = {
  id: string;
  content: string;
  token_count: number | null;
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

const statusClass: Record<KbSourceStatus, string> = {
  pending: 'badge--warn',
  indexed: 'badge--success',
  error: 'badge--danger',
};

function sourceLabel(source: SourceRow): string {
  if (source.type === 'text') return 'Manueller Text';
  return source.uri ?? '—';
}

export default async function SourceChunksPage({
  params,
  searchParams,
}: {
  params: Promise<{ sourceId: string }>;
  searchParams: Promise<{ org?: string; page?: string }>;
}) {
  const { sourceId } = await params;
  const { org, page } = await searchParams;
  const { orgId } = await requireActiveOrg(org);

  const supabase = await createSupabaseServerClient();
  const { data: sourceData } = await supabase
    .from('kb_sources')
    .select('id, type, uri, status, last_indexed_at, knowledge_base:knowledge_bases(name)')
    .eq('org_id', orgId)
    .eq('id', sourceId)
    .maybeSingle();
  if (!sourceData) notFound();
  const source = sourceData as unknown as SourceRow;

  const pageNum = Math.max(1, Number.parseInt(page ?? '1', 10) || 1);
  const from = (pageNum - 1) * PAGE_SIZE;
  const { data: chunkData, count } = await supabase
    .from('kb_chunks')
    .select('id, content, token_count', { count: 'exact' })
    .eq('org_id', orgId)
    .eq('source_id', sourceId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, from + PAGE_SIZE - 1);
  const chunks = (chunkData ?? []) as unknown as ChunkRow[];
  const total = count ?? chunks.length;
  const totalTokens = chunks.reduce((sum, chunk) => sum + (chunk.token_count ?? 0), 0);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const backHref = `/settings/knowledge?org=${orgId}`;
  const pageHref = (p: number) => `/settings/knowledge/source/${sourceId}?org=${orgId}&page=${p}`;

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Textbausteine</h1>
        <p>
          <Link href={backHref}>← Zurück zur Wissensdatenbank</Link>
        </p>
      </div>

      <div className="panel">
        <h2 style={{ wordBreak: 'break-all' }}>{sourceLabel(source)}</h2>
        <p className="help" style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <span>
            {source.knowledge_base?.name ?? 'Wissensdatenbank'} · {typeLabels[source.type]}
          </span>
          <span className={`badge ${statusClass[source.status]}`}>{statusLabels[source.status]}</span>
          <span>
            {total} {total === 1 ? 'Textbaustein' : 'Textbausteine'}
            {chunks.length > 0 && chunks.length < total
              ? ` (Seite ${pageNum} von ${lastPage})`
              : ''}
          </span>
        </p>
        <p className="hint">
          Genau dieser Wortlaut liegt im Index — inklusive der „Quelle:"-Kopfzeile. Der KI-Agent
          findet und zitiert ausschließlich diese Bausteine. Wirkt etwas veraltet oder falsch?
          Quelle anpassen und neu indizieren.
        </p>
      </div>

      {chunks.length === 0 ? (
        <div className="panel">
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            {source.status === 'pending'
              ? 'Noch keine Textbausteine — die Indizierung läuft gerade.'
              : 'Keine Textbausteine vorhanden. Quelle neu indizieren, falls hier Inhalte erwartet werden.'}
          </p>
        </div>
      ) : (
        chunks.map((chunk, index) => (
          <div className="panel" key={chunk.id}>
            <p className="hint" style={{ marginBottom: '0.5rem' }}>
              Baustein {from + index + 1} von {total}
              {chunk.token_count ? ` · ~${chunk.token_count} Tokens` : ''}
            </p>
            <p style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.92rem' }}>
              {chunk.content}
            </p>
          </div>
        ))
      )}

      {lastPage > 1 ? (
        <div className="panel" style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          {pageNum > 1 ? <Link href={pageHref(pageNum - 1)}>← Vorherige Seite</Link> : <span />}
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Seite {pageNum} von {lastPage} · {totalTokens ? `~${totalTokens} Tokens auf dieser Seite` : ''}
          </span>
          {pageNum < lastPage ? <Link href={pageHref(pageNum + 1)}>Nächste Seite →</Link> : null}
        </div>
      ) : null}
    </div>
  );
}
