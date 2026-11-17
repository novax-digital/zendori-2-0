// Chunk transparency view (page type C with a side rail): shows VERBATIM what
// is indexed for one kb_source — every Textbaustein exactly as the AI retrieves
// it (incl. the "Quelle: …" provenance header). Owner-facing traceability for
// the knowledge base; RLS scopes every query to the caller's org.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { KbSourceStatus, KbSourceType } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { canViewArea, isAdminRole, isKbImageFilename } from '@zendori/core';
import { href } from '@/lib/href';
import NoAccessPanel from '@/components/NoAccessPanel';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { SettingRow } from '@/components/ui/Field';
import { EmptyState, Property, PropertyList, Section } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import { setSourceShareable } from '../../actions';
import { SOURCE_TYPE_LABELS, SourceStatusBadge, formatRelative, sourceLabel } from '../../shared';

const PAGE_SIZE = 50;

type SourceRow = {
  id: string;
  knowledge_base_id: string;
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
  const COLUMNS =
    'id, knowledge_base_id, type, uri, status, last_indexed_at, knowledge_base:knowledge_bases(name)';
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
  const kbName = source.knowledge_base?.name ?? 'Wissensdatenbank';
  const kbHref = href(`/settings/knowledge/${source.knowledge_base_id}`, { org: orgId });
  const pageHref = (p: number) =>
    href(`/settings/knowledge/source/${sourceId}`, { org: orgId, page: p });

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[
          { label: 'Wissen', href: href('/settings/knowledge', { org: orgId }) },
          { label: kbName, href: kbHref },
          { label: 'Textbausteine' },
        ]}
        title={<span className="kb-break">{sourceLabel(source)}</span>}
        badges={<SourceStatusBadge status={source.status} />}
        subtitle="Genau dieser Wortlaut liegt im Index. Der KI-Agent findet und zitiert ausschließlich diese Bausteine."
      />

      <div className="page-split">
        <div className="page-body">
          {/* Release for outbound sending (0025). Only files have bytes to send, and
              only owners/admins may decide — the DB trigger enforces the same rule. */}
          {source.type === 'file' && shareableSupported ? (
            <Section
              title="Weitersenden an Kunden"
              help="Ob der Bot den Inhalt kennt, steuerst du über die Wissensdatenbanken des Agenten. Hier geht es nur darum, ob die Datei selbst das Haus verlassen darf."
            >
              <div className="form-narrow">
                <SettingRow
                  label={
                    source.is_shareable
                      ? 'Diese Datei ist freigegeben'
                      : 'Diese Datei ist nicht freigegeben'
                  }
                  help={
                    source.is_shareable
                      ? 'Nutzt der Bot diese Quelle für eine Antwort, hängt er die Datei an: im Chat, per WhatsApp oder als E-Mail-Anhang.'
                      : 'Der Bot darf ihren Inhalt für Antworten nutzen, die Datei selbst aber nicht an Kunden schicken.'
                  }
                >
                  {canRelease ? (
                    <form action={setSourceShareable}>
                      <input type="hidden" name="org" value={orgId} />
                      <input type="hidden" name="id" value={source.id} />
                      <input type="hidden" name="kb" value={source.knowledge_base_id} />
                      <input
                        type="hidden"
                        name="shareable"
                        value={source.is_shareable ? 'off' : 'on'}
                      />
                      <Button type="submit">
                        {source.is_shareable ? 'Freigabe entziehen' : 'Zum Senden freigeben'}
                      </Button>
                    </form>
                  ) : (
                    <Badge
                      tone={source.is_shareable ? 'success' : 'neutral'}
                      title="Ändern dürfen das nur Inhaber und Admins"
                    >
                      {source.is_shareable ? 'Freigegeben' : 'Nicht freigegeben'}
                    </Badge>
                  )}
                </SettingRow>
              </div>
            </Section>
          ) : null}

          <Section
            title={total === 1 ? '1 Textbaustein' : `${total} Textbausteine`}
            help={
              <>
                Inklusive der „Quelle:“-Kopfzeile. Wirkt etwas veraltet oder falsch? Quelle
                anpassen und neu indizieren.
                {isImage
                  ? ' Bei Bildern steht hier die KI-Beschreibung. Sie ersetzt das Bild für die Suche, das Bild selbst wird nicht durchsucht.'
                  : ''}
              </>
            }
          >
            {chunks.length === 0 ? (
              <EmptyState
                title="Keine Textbausteine"
                text={
                  source.status === 'pending'
                    ? 'Die Indizierung läuft gerade.'
                    : 'Indiziere die Quelle neu, falls hier Inhalte erwartet werden.'
                }
              />
            ) : (
              <div className="kb-chunks">
                {chunks.map((chunk, index) => (
                  <div className="kb-chunk" key={chunk.id}>
                    <div className="muted small">
                      Baustein {from + index + 1} von {total}
                      {chunk.token_count ? ` · ~${chunk.token_count} Tokens` : ''}
                    </div>
                    <p className="kb-chunk-text">{chunk.content}</p>
                  </div>
                ))}
              </div>
            )}

            {lastPage > 1 ? (
              <div className="row row--between">
                <span className="muted small">
                  Seite {pageNum} von {lastPage}
                  {totalTokens ? ` · ~${totalTokens} Tokens auf dieser Seite` : ''}
                </span>
                <div className="row">
                  {pageNum > 1 ? (
                    <Button href={pageHref(pageNum - 1)} size="sm">
                      Vorherige Seite
                    </Button>
                  ) : null}
                  {pageNum < lastPage ? (
                    <Button href={pageHref(pageNum + 1)} size="sm">
                      Nächste Seite
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </Section>
        </div>

        <aside className="page-rail" aria-label="Quelle">
          <div className="rail-section">
            <h2>Quelle</h2>
            <PropertyList>
              <Property label="Wissensdatenbank">
                <Link href={kbHref}>{kbName}</Link>
              </Property>
              <Property label="Typ">{SOURCE_TYPE_LABELS[source.type]}</Property>
              <Property label="Status">
                <SourceStatusBadge status={source.status} />
              </Property>
              <Property label="Textbausteine">{total}</Property>
              <Property label="Zuletzt indiziert">{formatRelative(source.last_indexed_at)}</Property>
            </PropertyList>
          </div>
        </aside>
      </div>
    </div>
  );
}
