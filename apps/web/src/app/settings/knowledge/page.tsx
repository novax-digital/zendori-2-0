import type { ReactNode } from 'react';
import Link from 'next/link';
import type { KbSourceStatus, KbSourceType } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import KnowledgeTabs, { type KbTabKey } from '@/components/KnowledgeTabs';
import KbGallery, { type KbTileMeta } from '@/components/KbGallery';
import KbFileUpload from '@/components/KbFileUpload';
import KbIndexingPoller from '@/components/KbIndexingPoller';
import DangerDeleteKb from '@/components/DangerDeleteKb';
import DismissibleBanners from '@/components/DismissibleBanners';
import {
  addQaCsvSource,
  addTextSource,
  addUrlSource,
  createKnowledgeBase,
  deleteKnowledgeBase,
  deleteSource,
  reindexSource,
} from './actions';

type KbRow = {
  id: string;
  name: string;
  description: string | null;
};

type KbSourceRow = {
  id: string;
  knowledge_base_id: string;
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

const statusClass: Record<KbSourceStatus, string> = {
  pending: 'badge--warn',
  indexed: 'badge--success',
  error: 'badge--danger',
};



function statusBadge(status: KbSourceStatus) {
  return (
    <span className={`badge ${statusClass[status]}`}>{statusLabels[status]}</span>
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

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, orgs } = await requireActiveOrg(org);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';

  const supabase = await createSupabaseServerClient();
  const [{ data: kbData }, { data: sourceData }, { data: linkData }] = await Promise.all([
    supabase
      .from('knowledge_bases')
      .select('id, name, description')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true }),
    supabase
      .from('kb_sources')
      .select('id, knowledge_base_id, type, uri, status, last_indexed_at, created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false }),
    supabase.from('agent_knowledge_bases').select('knowledge_base_id').eq('org_id', orgId),
  ]);
  const kbs = (kbData ?? []) as KbRow[];
  const sources = (sourceData ?? []) as unknown as KbSourceRow[];
  const agentLinks = (linkData ?? []) as { knowledge_base_id: string }[];

  // Learning loop (0020): open proposal count for the entry banner. Defensive —
  // before the migration the table is missing and the count stays hidden.
  let learnedProposedCount = 0;
  {
    const { count, error: learnedError } = await supabase
      .from('learned_answers')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('status', 'proposed');
    if (!learnedError) learnedProposedCount = count ?? 0;
  }

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

  const sourcesByKb = new Map<string, KbSourceRow[]>();
  for (const source of sources) {
    const list = sourcesByKb.get(source.knowledge_base_id) ?? [];
    list.push(source);
    sourcesByKb.set(source.knowledge_base_id, list);
  }
  const agentCountByKb = new Map<string, number>();
  for (const link of agentLinks) {
    agentCountByKb.set(
      link.knowledge_base_id,
      (agentCountByKb.get(link.knowledge_base_id) ?? 0) + 1
    );
  }

  const tiles: KbTileMeta[] = kbs.map((kb) => ({
    id: kb.id,
    name: kb.name,
    description: kb.description,
    sourceCount: sourcesByKb.get(kb.id)?.length ?? 0,
    agentCount: agentCountByKb.get(kb.id) ?? 0,
  }));

  const addTabsFor = (kb: KbRow): { key: KbTabKey; label: string; panel: ReactNode }[] => [
    {
      key: 'url',
      label: 'URL',
      panel: (
        <>
          <p className="help">
            Eine Webseite oder Sitemap (.xml). Bei einer Sitemap werden bis zu 20 verlinkte Seiten
            eingelesen.
          </p>
          <form className="stack" action={addUrlSource} style={{ maxWidth: '32rem' }}>
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="knowledgeBaseId" value={kb.id} />
            <div>
              <label htmlFor={`url-${kb.id}`}>URL</label>
              <input
                id={`url-${kb.id}`}
                name="url"
                type="url"
                required
                placeholder="https://www.beispiel.de/hilfe"
              />
            </div>
            <button className="primary" type="submit">
              URL hinzufügen
            </button>
          </form>
        </>
      ),
    },
    {
      key: 'file',
      label: 'Datei',
      panel: (
        <>
          <p className="help">
            PDF, DOCX, TXT, MD oder CSV, maximal 15 MB pro Datei. Mehrere Dateien auf einmal
            möglich — der Text wird aus jeder Datei extrahiert und indiziert (CSV-Dateien werden
            als Frage-Antwort-Paare eingelesen, siehe Tab „Q&amp;A (CSV)").
          </p>
          <KbFileUpload org={orgId} knowledgeBaseId={kb.id} />
        </>
      ),
    },
    {
      key: 'qa',
      label: 'Q&A (CSV)',
      panel: (
        <>
          <p className="help">
            Fragen und Antworten als CSV importieren — zwei Spalten{' '}
            <strong>Frage;Antwort</strong> (Semikolon oder Komma, optionale Kopfzeile,
            Anführungszeichen für mehrzeilige Antworten). Jedes Paar wird als eigener
            Textbaustein indiziert — das ideale Format, damit der Agent Kundenfragen präzise
            trifft. Export aus Excel: „Speichern unter" → CSV.
          </p>
          <form className="stack" action={addQaCsvSource} style={{ maxWidth: '32rem' }}>
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="knowledgeBaseId" value={kb.id} />
            <div>
              <label htmlFor={`qa-file-${kb.id}`}>CSV-Datei</label>
              <input id={`qa-file-${kb.id}`} name="file" type="file" accept=".csv,text/csv" required />
            </div>
            <button className="primary" type="submit">
              Q&amp;A importieren
            </button>
          </form>
        </>
      ),
    },
    {
      key: 'text',
      label: 'Text',
      panel: (
        <>
          <p className="help">
            Ein manuell gepflegter Text — z. B. Rückgabebedingungen, FAQ-Antworten oder interne
            Hinweise, die der KI-Agent kennen soll.
          </p>
          <form className="stack" action={addTextSource} style={{ maxWidth: '32rem' }}>
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="knowledgeBaseId" value={kb.id} />
            <div>
              <label htmlFor={`title-${kb.id}`}>Titel</label>
              <input
                id={`title-${kb.id}`}
                name="title"
                type="text"
                required
                minLength={1}
                maxLength={200}
                placeholder="z. B. Rückgabebedingungen"
              />
            </div>
            <div>
              <label htmlFor={`text-${kb.id}`}>Text</label>
              <textarea id={`text-${kb.id}`} name="text" rows={6} required />
            </div>
            <button className="primary" type="submit">
              Text hinzufügen
            </button>
          </form>
        </>
      ),
    },
  ];

  const panels: Record<string, ReactNode> = {};
  for (const kb of kbs) {
    const kbSources = sourcesByKb.get(kb.id) ?? [];
    const kbHasPending = kbSources.some((s) => s.status === 'pending');
    const agentCount = agentCountByKb.get(kb.id) ?? 0;
    panels[kb.id] = (
      <div key={kb.id}>
        <div className="panel">
          <h2>Quellen — {kb.name}</h2>
          {agentCount === 0 ? (
            <p className="notice" style={{ marginBottom: '1rem' }}>
              Diese Wissensdatenbank ist mit keinem Agenten verknüpft — ihr Inhalt wird aktuell
              von keiner KI genutzt. Verknüpfen unter Einstellungen → Agenten.
            </p>
          ) : null}
          {kbSources.length === 0 ? (
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
                  <th>Textbausteine</th>
                  <th>Zuletzt indiziert</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {kbSources.map((source) => (
                  <tr key={source.id}>
                    <td>{typeLabels[source.type]}</td>
                    <td style={{ wordBreak: 'break-all' }}>{sourceLabel(source)}</td>
                    <td>{statusBadge(source.status)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {(chunkCounts.get(source.id) ?? 0) > 0 ? (
                        <Link href={`/settings/knowledge/source/${source.id}?org=${orgId}`}>
                          {chunkCounts.get(source.id)} ansehen
                        </Link>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
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
          {kbHasPending ? (
            <p className="hint" style={{ marginTop: '0.6rem' }}>
              Ausstehende Quellen werden im Hintergrund indiziert — diese Ansicht aktualisiert
              sich automatisch, sobald die Indizierung abgeschlossen ist.
            </p>
          ) : null}
        </div>

        <KnowledgeTabs tabs={addTabsFor(kb)} />

        <div className="panel">
          <h2>Wissensdatenbank löschen</h2>
          <p className="help">
            Löscht „{kb.name}" mitsamt {kbSources.length === 1 ? 'ihrer Quelle' : 'allen Quellen'}{' '}
            und deren Index — Agenten verlieren die Verknüpfung. Nicht rückgängig machbar, daher
            nur nach Eingabe deines aktuellen Passworts.
          </p>
          <DangerDeleteKb org={orgId} kbId={kb.id} kbName={kb.name} action={deleteKnowledgeBase} />
        </div>
      </div>
    );
  }

  const newPanel: ReactNode = (
    <div className="panel">
      <h2>Neue Wissensdatenbank</h2>
      <p className="help">
        Bündle Quellen thematisch (z. B. „Website-FAQ", „Interne Doku", „Produktkatalog") und
        verknüpfe sie gezielt mit Agenten — so weiß jeder Agent nur, was er wissen soll.
      </p>
      <form className="stack" action={createKnowledgeBase} style={{ maxWidth: '28rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <div>
          <label htmlFor="kb-name">Name</label>
          <input
            id="kb-name"
            name="name"
            type="text"
            required
            minLength={2}
            maxLength={80}
            placeholder="z. B. Website-FAQ"
          />
        </div>
        <div>
          <label htmlFor="kb-description">Beschreibung (optional)</label>
          <input
            id="kb-description"
            name="description"
            type="text"
            maxLength={300}
            placeholder="Was liegt hier drin?"
          />
        </div>
        <button className="primary" type="submit">
          Wissensdatenbank anlegen
        </button>
      </form>
    </div>
  );

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Wissensdatenbank</h1>
        <p>
          Das Wissen von {orgName}, gebündelt in Datenbanken: Quellen werden im Hintergrund
          zerlegt und als Embeddings indiziert. Welche Datenbanken ein Agent nutzt, legst du unter
          Einstellungen → Agenten fest.
        </p>
      </div>

      <DismissibleBanners error={error} notice={notice} style={{ marginBottom: '1.5rem' }} />

      {/* auto-refresh while any source is still indexing (kb_sources has no
          realtime publication — polling is the migration-free mechanism) */}
      <KbIndexingPoller active={sources.some((s) => s.status === 'pending')} />

      <div className="panel" style={{ marginBottom: '1.5rem' }}>
        <h2>Gelernte Antworten</h2>
        <p className="help">
          Zendori lernt aus Mitarbeiter-Antworten und Entwurfs-Korrekturen — als anonymisierte
          Frage-Antwort-Vorschläge, die du vor der Übernahme prüfst.{' '}
          {learnedProposedCount > 0 ? (
            <strong>
              {learnedProposedCount}{' '}
              {learnedProposedCount === 1 ? 'Vorschlag wartet' : 'Vorschläge warten'} auf Prüfung.
            </strong>
          ) : (
            'Aktuell keine offenen Vorschläge.'
          )}{' '}
          <Link href={`/settings/knowledge/learned?org=${orgId}`}>Vorschläge prüfen →</Link>
        </p>
      </div>

      <KbGallery tiles={tiles} panels={panels} newPanel={newPanel} />
    </div>
  );
}
