// One knowledge base (page type C with URL-driven tabs): its sources and, on
// the "Einstellungen" tab, the password-gated delete. Sources are added in the
// drawer (?panel=source&type=url|file|text|qa). Replaces the former tile
// gallery, where a base was only a piece of client state on the list page.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { KbSourceStatus, KbSourceType } from '@zendori/core';
import { canViewArea } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { href } from '@/lib/href';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import DangerDeleteKb from '@/components/DangerDeleteKb';
import DismissibleBanners from '@/components/DismissibleBanners';
import KbFileUpload from '@/components/KbFileUpload';
import KbIndexingPoller from '@/components/KbIndexingPoller';
import NoAccessPanel from '@/components/NoAccessPanel';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field, OptionGroup } from '@/components/ui/Field';
import { EmptyState, Property, PropertyList, Section, Tabs } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import {
  addQaCsvSource,
  addTextSource,
  addUrlSource,
  deleteKnowledgeBase,
  deleteSource,
  reindexSource,
} from '../actions';
import {
  SOURCE_KINDS,
  SOURCE_TYPE_LABELS,
  SourceStatusBadge,
  UUID_PATTERN,
  formatRelative,
  sourceLabel,
  type SourceKind,
} from '../shared';

type KbRow = {
  id: string;
  name: string;
  description: string | null;
};

type KbSourceRow = {
  id: string;
  type: KbSourceType;
  uri: string | null;
  status: KbSourceStatus;
  last_indexed_at: string | null;
};

const SOURCE_FORM = 'kb-source';

const KIND_OPTIONS: { value: SourceKind; title: string; help: string }[] = [
  { value: 'url', title: 'Website', help: 'Eine Seite oder eine Sitemap einlesen' },
  { value: 'file', title: 'Datei', help: 'PDF, DOCX, TXT, MD oder Bilder hochladen' },
  { value: 'text', title: 'Text', help: 'Einen Text selbst eintragen' },
  { value: 'qa', title: 'Fragen und Antworten', help: 'Eine CSV mit zwei Spalten importieren' },
];

const SUBMIT_LABELS: Record<Exclude<SourceKind, 'file'>, string> = {
  url: 'URL hinzufügen',
  text: 'Text hinzufügen',
  qa: 'Importieren',
};

export default async function KnowledgeBasePage({
  params,
  searchParams,
}: {
  params: Promise<{ kbId: string }>;
  searchParams: Promise<{
    org?: string;
    error?: string;
    notice?: string;
    tab?: string;
    panel?: string;
    type?: string;
  }>;
}) {
  const { kbId } = await params;
  const { org, error, notice, tab, panel, type } = await searchParams;
  const { orgId, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'knowledge')) return <NoAccessPanel title="Wissensdatenbank" />;
  if (!UUID_PATTERN.test(kbId)) notFound();

  const supabase = await createSupabaseServerClient();
  const [{ data: kbData }, { data: sourceData }, { count: agentCountRaw }] = await Promise.all([
    supabase
      .from('knowledge_bases')
      .select('id, name, description')
      .eq('org_id', orgId)
      .eq('id', kbId)
      .maybeSingle(),
    supabase
      .from('kb_sources')
      .select('id, type, uri, status, last_indexed_at')
      .eq('org_id', orgId)
      .eq('knowledge_base_id', kbId)
      .order('created_at', { ascending: false }),
    supabase
      .from('agent_knowledge_bases')
      .select('knowledge_base_id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('knowledge_base_id', kbId),
  ]);
  if (!kbData) notFound();
  const kb = kbData as KbRow;
  const sources = (sourceData ?? []) as unknown as KbSourceRow[];
  const agentCount = agentCountRaw ?? 0;

  // Per-source chunk counts (Textbausteine) — cheap HEAD count queries, run in
  // parallel. This is the owner-facing proof of WHAT is actually indexed.
  const chunkCounts = new Map<string, number>();
  await Promise.all(
    sources.map(async (source) => {
      const { count } = await supabase
        .from('kb_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('source_id', source.id);
      chunkCounts.set(source.id, count ?? 0);
    })
  );

  const base = `/settings/knowledge/${kb.id}`;
  const settings = tab === 'settings';
  const tabHref = href(base, { org: orgId, tab: settings ? 'settings' : undefined });
  const drawerOpen = panel === 'source';
  const kind: SourceKind = SOURCE_KINDS.includes(type as SourceKind) ? (type as SourceKind) : 'url';
  const addHref = href(base, { org: orgId, panel: 'source', type: 'url' });
  const hasPending = sources.some((s) => s.status === 'pending');
  // Re-mounts the row menus when an action comes back, so none stays open.
  const menuKey = `${notice ?? ''}|${error ?? ''}`;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[
          { label: 'Wissen', href: href('/settings/knowledge', { org: orgId }) },
          { label: kb.name },
        ]}
        title={kb.name}
        badges={
          agentCount === 0 ? (
            <Badge tone="warn">Kein Agent</Badge>
          ) : (
            <Badge>{agentCount === 1 ? '1 Agent' : `${agentCount} Agenten`}</Badge>
          )
        }
        subtitle={kb.description?.trim() || undefined}
        actions={
          settings ? undefined : (
            <Button href={addHref} variant="primary" icon="plus" scroll={false}>
              Quelle hinzufügen
            </Button>
          )
        }
        tabs={
          <Tabs
            label="Bereiche der Wissensdatenbank"
            items={[
              {
                label: 'Quellen',
                href: href(base, { org: orgId }),
                count: sources.length,
                active: !settings,
              },
              {
                label: 'Einstellungen',
                href: href(base, { org: orgId, tab: 'settings' }),
                active: settings,
              },
            ]}
          />
        }
      />

      <div className="page-body">
        <div className="stack stack--lg">
          {/* an error that belongs to the open drawer is shown inside the drawer */}
          <DismissibleBanners error={drawerOpen ? undefined : error} notice={notice} />

          {/* auto-refresh while any source is still indexing (kb_sources has no
              realtime publication — polling is the migration-free mechanism) */}
          <KbIndexingPoller active={hasPending} />

          {settings ? (
            <div className="form-narrow">
              <Section title="Details">
                <PropertyList>
                  <Property label="Name">{kb.name}</Property>
                  <Property label="Beschreibung">{kb.description?.trim() || '—'}</Property>
                  <Property label="Quellen">{sources.length}</Property>
                  <Property label="Verknüpfte Agenten">{agentCount}</Property>
                </PropertyList>
              </Section>
              <Section
                title="Wissensdatenbank löschen"
                help={`Löscht „${kb.name}“ mitsamt ${
                  sources.length === 1 ? 'ihrer Quelle' : 'allen Quellen'
                } und deren Index. Agenten verlieren die Verknüpfung. Das lässt sich nicht rückgängig machen, daher nur nach Eingabe deines aktuellen Passworts.`}
              >
                <DangerDeleteKb
                  org={orgId}
                  kbId={kb.id}
                  kbName={kb.name}
                  action={deleteKnowledgeBase}
                />
              </Section>
            </div>
          ) : (
            <>
              {agentCount === 0 ? (
                <Callout tone="warn" title="Mit keinem Agenten verknüpft">
                  Der Inhalt dieser Wissensdatenbank wird aktuell von keiner KI genutzt.{' '}
                  <Link href={href('/settings/agents', { org: orgId })}>
                    Unter Agenten verknüpfen
                  </Link>
                </Callout>
              ) : null}

              {sources.length === 0 ? (
                <EmptyState
                  title="Noch keine Quellen"
                  text="Füge eine Website, eine Datei, einen Text oder Fragen und Antworten hinzu."
                  action={
                    <Button href={addHref} variant="primary" icon="plus" scroll={false}>
                      Quelle hinzufügen
                    </Button>
                  }
                />
              ) : (
                <div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Quelle</th>
                          <th>Status</th>
                          <th>Textbausteine</th>
                          <th>Zuletzt indiziert</th>
                          <th aria-label="Aktionen" />
                        </tr>
                      </thead>
                      <tbody>
                        {sources.map((source) => {
                          const label = sourceLabel(source);
                          const chunks = chunkCounts.get(source.id) ?? 0;
                          return (
                            <tr key={source.id}>
                              <td>
                                <Link
                                  href={href(`/settings/knowledge/source/${source.id}`, {
                                    org: orgId,
                                  })}
                                  className="cell-title kb-break"
                                >
                                  {label}
                                </Link>
                                <div className="cell-sub">{SOURCE_TYPE_LABELS[source.type]}</div>
                              </td>
                              <td>
                                <SourceStatusBadge status={source.status} />
                              </td>
                              <td>{chunks > 0 ? chunks : <span className="muted">—</span>}</td>
                              <td className="muted nowrap">
                                {formatRelative(source.last_indexed_at)}
                              </td>
                              <td className="cell-actions">
                                <Menu key={menuKey} label={`Aktionen für ${label}`}>
                                  <form action={reindexSource}>
                                    <input type="hidden" name="org" value={orgId} />
                                    <input type="hidden" name="id" value={source.id} />
                                    <input type="hidden" name="kb" value={kb.id} />
                                    <button className="menu-item" type="submit">
                                      <span className="menu-label">Neu indizieren</span>
                                    </button>
                                  </form>
                                  <form action={deleteSource}>
                                    <input type="hidden" name="org" value={orgId} />
                                    <input type="hidden" name="id" value={source.id} />
                                    <input type="hidden" name="kb" value={kb.id} />
                                    {/* two-step confirm (owner 2026-07-24): deletion removes the
                                        chunks immediately from every agent's retrieval */}
                                    <ConfirmDeleteButton
                                      inMenu
                                      label="Löschen"
                                      confirmLabel="Wirklich löschen"
                                    />
                                  </form>
                                </Menu>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {hasPending ? (
                    <p className="field-help">
                      Ausstehende Quellen werden im Hintergrund indiziert. Diese Ansicht
                      aktualisiert sich automatisch, sobald die Indizierung abgeschlossen ist.
                    </p>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {drawerOpen ? (
        <Drawer
          title="Quelle hinzufügen"
          closeHref={tabHref}
          footer={
            kind === 'file' ? (
              // the uploader has its own button: files go straight to storage
              <Button href={tabHref} scroll={false}>
                Schließen
              </Button>
            ) : (
              <>
                <Button href={tabHref} scroll={false}>
                  Abbrechen
                </Button>
                <Button type="submit" form={SOURCE_FORM} variant="primary">
                  {SUBMIT_LABELS[kind]}
                </Button>
              </>
            )
          }
        >
          <DismissibleBanners error={error} />
          <OptionGroup
            label="Art der Quelle"
            value={kind}
            options={KIND_OPTIONS.map((option) => ({
              ...option,
              href: href(base, { org: orgId, panel: 'source', type: option.value }),
            }))}
          />

          {kind === 'url' ? (
            <form id={SOURCE_FORM} className="stack" action={addUrlSource}>
              <input type="hidden" name="org" value={orgId} />
              <input type="hidden" name="knowledgeBaseId" value={kb.id} />
              <Field
                label="URL"
                htmlFor="kb-url"
                help="Eine Webseite oder eine Sitemap (.xml). Bei einer Sitemap werden bis zu 20 verlinkte Seiten eingelesen."
              >
                <input
                  id="kb-url"
                  name="url"
                  type="url"
                  required
                  placeholder="https://www.beispiel.de/hilfe"
                />
              </Field>
            </form>
          ) : null}

          {kind === 'file' ? (
            <div className="stack">
              <p className="field-help">
                Mehrere Dateien auf einmal möglich. Der Text wird aus jeder Datei extrahiert und
                indiziert. Bilder beschreibt die KI beim Hochladen: was zu sehen ist, welche
                Stellen markiert sind und was auf dem Gerät steht. Danach sind sie über diese
                Beschreibung auffindbar. Fragen und Antworten als CSV importierst du über
                „Fragen und Antworten“.
              </p>
              <KbFileUpload org={orgId} knowledgeBaseId={kb.id} />
            </div>
          ) : null}

          {kind === 'text' ? (
            <form id={SOURCE_FORM} className="stack" action={addTextSource}>
              <input type="hidden" name="org" value={orgId} />
              <input type="hidden" name="knowledgeBaseId" value={kb.id} />
              <Field label="Titel" htmlFor="kb-title">
                <input
                  id="kb-title"
                  name="title"
                  type="text"
                  required
                  minLength={1}
                  maxLength={200}
                  placeholder="z. B. Rückgabebedingungen"
                />
              </Field>
              <Field
                label="Text"
                htmlFor="kb-text"
                help="Zum Beispiel Rückgabebedingungen, FAQ-Antworten oder interne Hinweise, die der KI-Agent kennen soll."
              >
                <textarea id="kb-text" name="text" rows={8} required />
              </Field>
            </form>
          ) : null}

          {kind === 'qa' ? (
            <form id={SOURCE_FORM} className="stack" action={addQaCsvSource}>
              <input type="hidden" name="org" value={orgId} />
              <input type="hidden" name="knowledgeBaseId" value={kb.id} />
              <Field
                label="CSV-Datei"
                htmlFor="kb-qa-file"
                help="Zwei Spalten „Frage;Antwort“, getrennt durch Semikolon oder Komma, Kopfzeile optional, Anführungszeichen für mehrzeilige Antworten. Jedes Paar wird ein eigener Textbaustein. Aus Excel: „Speichern unter“ und CSV wählen."
              >
                <input id="kb-qa-file" name="file" type="file" accept=".csv,text/csv" required />
              </Field>
            </form>
          ) : null}
        </Drawer>
      ) : null}
    </div>
  );
}
