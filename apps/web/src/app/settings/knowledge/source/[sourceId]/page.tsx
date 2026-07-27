// Chunk transparency view: shows VERBATIM what is indexed for one kb_source —
// every Textbaustein exactly as the AI retrieves it (incl. the "Quelle: …"
// provenance header). Owner-facing traceability for the knowledge base; RLS
// scopes every query to the caller's org.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { KbSourceStatus, KbSourceType } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { canViewArea, isAdminRole, isKbImageFilename } from '@zendori/core';
import NoAccessPanel from '@/components/NoAccessPanel';
import { setSourceShareable } from '../../actions';

const PAGE_SIZE = 50;

type SourceRow = {
  id: string;
  type: KbSourceType;
  uri: string | null;
  status: KbSourceStatus;
  last_indexed_at: string | null;
  /** 0025: released for outbound sending by the bot. */
  is_shareable: boolean;
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
  const { orgId, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'knowledge')) return <NoAccessPanel title="Wissensdatenbank" />;

  const supabase = await createSupabaseServerClient();
  const COLUMNS = 'id, type, uri, status, last_indexed_at, knowledge_base:knowledge_bases(name)';
  // is_shareable is 0025 — retry without it while the migration is pending (the
  // same 42703 schema-skew pattern used elsewhere; an unreleased file is the
  // correct assumption pre-migration).
  const withFlag = await supabase
    .from('kb_sources')
    .select(`${COLUMNS}, is_shareable`)
    .eq('org_id', orgId)
    .eq('id', sourceId)
    .maybeSingle();
  let sourceData = withFlag.data;
  const sourceError = withFlag.error;
  let shareableSupported = true;
  if (sourceError && (sourceError as { code?: string }).code === '42703') {
    shareableSupported = false;
    ({ data: sourceData } = await supabase
      .from('kb_sources')
      .select(COLUMNS)
      .eq('org_id', orgId)
      .eq('id', sourceId)
      .maybeSingle());
  }
  if (!sourceData) notFound();
  const source = { is_shareable: false, ...(sourceData as object) } as unknown as SourceRow;

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

  const isImage = source.type === 'file' && isKbImageFilename(source.uri ?? '');
  const canRelease = isAdminRole(access.role);
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
          {isImage
            ? ' Bei Bildern steht hier die KI-Beschreibung — sie ersetzt das Bild für die Suche, das Bild selbst wird nicht durchsucht.'
            : ''}
        </p>
      </div>

      {/* Release for outbound sending (0025). Only files have bytes to send, and
          only owners/admins may decide — the DB trigger enforces the same rule. */}
      {source.type === 'file' && shareableSupported ? (
        <div className="panel">
          <h2>Weitersenden an Kunden</h2>
          <p className="help">
            {source.is_shareable
              ? 'Diese Datei ist freigegeben: Nutzt der Bot diese Quelle für eine Antwort, hängt er die Datei an — im Chat, per WhatsApp oder als E-Mail-Anhang.'
              : 'Diese Datei ist nicht freigegeben. Der Bot darf ihren Inhalt für Antworten nutzen, die Datei selbst aber nicht an Kunden schicken.'}
          </p>
          <p className="hint">
            Zwei verschiedene Dinge: Ob der Bot den <em>Inhalt</em> kennt, steuern Sie über die
            Wissensdatenbanken des Agenten. Hier geht es nur darum, ob die <em>Datei</em> das Haus
            verlassen darf. Interne Unterlagen wie Preiskalkulationen bleiben also aus, auch wenn der
            Bot daraus antwortet.
          </p>
          {canRelease ? (
            <form action={setSourceShareable}>
              <input type="hidden" name="org" value={orgId} />
              <input type="hidden" name="id" value={source.id} />
              <input type="hidden" name="shareable" value={source.is_shareable ? 'off' : 'on'} />
              <button type="submit" className={source.is_shareable ? 'button' : 'button button--primary'}>
                {source.is_shareable ? 'Freigabe entziehen' : 'Zum Senden freigeben'}
              </button>
            </form>
          ) : (
            <p className="hint">
              <span className={`badge ${source.is_shareable ? 'badge--success' : ''}`}>
                {source.is_shareable ? 'Freigegeben' : 'Nicht freigegeben'}
              </span>{' '}
              Ändern dürfen das nur Inhaber und Admins.
            </p>
          )}
        </div>
      ) : null}

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
