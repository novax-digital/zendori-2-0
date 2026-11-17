// Wissen: list of the organisation's knowledge bases (page type B). One
// knowledge base opens on its own page (/settings/knowledge/[kbId]); a new one
// is created in the drawer (?panel=new).
import Link from 'next/link';
import type { KbSourceStatus } from '@zendori/core';
import { canViewArea } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { href } from '@/lib/href';
import DismissibleBanners from '@/components/DismissibleBanners';
import KbIndexingPoller from '@/components/KbIndexingPoller';
import NoAccessPanel from '@/components/NoAccessPanel';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';
import { createKnowledgeBase } from './actions';
import { formatRelative } from './shared';

type KbRow = {
  id: string;
  name: string;
  description: string | null;
};

type KbSourceRow = {
  knowledge_base_id: string;
  status: KbSourceStatus;
  last_indexed_at: string | null;
};

/** One badge for the indexing state of a whole knowledge base. */
function IndexState({ sources }: { sources: KbSourceRow[] }) {
  if (sources.length === 0) return <Badge tone="muted">Leer</Badge>;
  const errors = sources.filter((s) => s.status === 'error').length;
  if (errors > 0) {
    return (
      <Badge tone="danger" dot>
        {errors === 1 ? '1 Fehler' : `${errors} Fehler`}
      </Badge>
    );
  }
  if (sources.some((s) => s.status === 'pending')) {
    return (
      <Badge tone="warn" dot>
        Wird indiziert
      </Badge>
    );
  }
  return (
    <Badge tone="success" dot>
      Indiziert
    </Badge>
  );
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string; panel?: string }>;
}) {
  const { org, error, notice, panel } = await searchParams;
  const { orgId, orgs, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'knowledge')) return <NoAccessPanel title="Wissensdatenbank" />;
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
      .select('knowledge_base_id, status, last_indexed_at')
      .eq('org_id', orgId),
    supabase.from('agent_knowledge_bases').select('knowledge_base_id').eq('org_id', orgId),
  ]);
  const kbs = (kbData ?? []) as KbRow[];
  const sources = (sourceData ?? []) as unknown as KbSourceRow[];
  const agentLinks = (linkData ?? []) as { knowledge_base_id: string }[];

  // Learning loop (0020): open proposal count for the page head. Defensive —
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

  const listHref = href('/settings/knowledge', { org: orgId });
  const newHref = href('/settings/knowledge', { org: orgId, panel: 'new' });
  const drawerOpen = panel === 'new';

  return (
    <div className="page">
      <PageHeader
        title="Wissensdatenbank"
        subtitle={`Das Wissen von ${orgName}, gebündelt in Datenbanken, die du gezielt mit Agenten verknüpfst.`}
        actions={
          <>
            <Button href={href('/settings/knowledge/learned', { org: orgId })}>
              Gelernte Antworten
              {learnedProposedCount > 0 ? (
                <Badge
                  tone="accent"
                  title={
                    learnedProposedCount === 1
                      ? '1 Vorschlag wartet auf Prüfung'
                      : `${learnedProposedCount} Vorschläge warten auf Prüfung`
                  }
                >
                  {learnedProposedCount}
                </Badge>
              ) : null}
            </Button>
            {/* former sidebar entry "MD-Generator" (needs the same 'knowledge' view right) */}
            <Button href={href('/tools/md-generator', { org: orgId })}>MD-Generator</Button>
            <Button href={newHref} variant="primary" icon="plus" scroll={false}>
              Neue Wissensdatenbank
            </Button>
          </>
        }
      />

      <div className="page-body">
        <div className="stack">
          {/* an error that belongs to the open drawer is shown inside the drawer */}
          <DismissibleBanners error={drawerOpen ? undefined : error} notice={notice} />

          {/* auto-refresh while any source is still indexing (kb_sources has no
              realtime publication — polling is the migration-free mechanism) */}
          <KbIndexingPoller active={sources.some((s) => s.status === 'pending')} />

          {kbs.length === 0 ? (
            <EmptyState
              title="Noch keine Wissensdatenbank"
              text="Bündle Quellen thematisch, zum Beispiel „Website-FAQ“ oder „Produktkatalog“, und verknüpfe sie mit Agenten."
              action={
                <Button href={newHref} variant="primary" icon="plus" scroll={false}>
                  Neue Wissensdatenbank
                </Button>
              }
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Wissensdatenbank</th>
                    <th>Quellen</th>
                    <th>Status</th>
                    <th>Agenten</th>
                    <th>Zuletzt indiziert</th>
                  </tr>
                </thead>
                <tbody>
                  {kbs.map((kb) => {
                    const kbSources = sourcesByKb.get(kb.id) ?? [];
                    const agentCount = agentCountByKb.get(kb.id) ?? 0;
                    const lastIndexed = kbSources
                      .map((s) => s.last_indexed_at)
                      .filter((value): value is string => Boolean(value))
                      .sort()
                      .pop();
                    return (
                      <tr key={kb.id}>
                        <td>
                          <Link
                            href={href(`/settings/knowledge/${kb.id}`, { org: orgId })}
                            className="cell-title"
                          >
                            {kb.name}
                          </Link>
                          {kb.description?.trim() ? (
                            <div className="cell-sub">{kb.description}</div>
                          ) : null}
                        </td>
                        <td>{kbSources.length}</td>
                        <td>
                          <IndexState sources={kbSources} />
                        </td>
                        <td>
                          {agentCount === 0 ? (
                            <Badge
                              tone="warn"
                              title="Mit keinem Agenten verknüpft — der Inhalt wird von keiner KI genutzt"
                            >
                              Kein Agent
                            </Badge>
                          ) : (
                            agentCount
                          )}
                        </td>
                        <td className="muted">{formatRelative(lastIndexed ?? null)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {drawerOpen ? (
        <Drawer
          title="Neue Wissensdatenbank"
          closeHref={listHref}
          footer={
            <>
              <Button href={listHref} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="kb-new" variant="primary">
                Wissensdatenbank anlegen
              </Button>
            </>
          }
        >
          <DismissibleBanners error={error} />
          <form id="kb-new" className="stack" action={createKnowledgeBase}>
            <input type="hidden" name="org" value={orgId} />
            <Field
              label="Name"
              htmlFor="kb-name"
              help="Bündle Quellen thematisch, zum Beispiel „Website-FAQ“, „Interne Doku“ oder „Produktkatalog“."
            >
              <input
                id="kb-name"
                name="name"
                type="text"
                required
                minLength={2}
                maxLength={80}
                placeholder="z. B. Website-FAQ"
              />
            </Field>
            <Field label="Beschreibung (optional)" htmlFor="kb-description">
              <input
                id="kb-description"
                name="description"
                type="text"
                maxLength={300}
                placeholder="Was liegt hier drin?"
              />
            </Field>
          </form>
        </Drawer>
      ) : null}
    </div>
  );
}
