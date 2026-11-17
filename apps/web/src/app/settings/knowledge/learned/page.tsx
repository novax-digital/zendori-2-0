// Review queue for the learning loop ("Gelernte Antworten", migration 0020):
// distilled, PII-free Q&A proposals wait here for human approval. Approving
// (optionally after editing) compiles all approved pairs into the per-org
// learned-answers CSV source, which the standard pipeline indexes — one chunk
// per pair. Members review (content management is member-level, like sources).
import Link from 'next/link';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { href } from '@/lib/href';
import DismissibleBanners from '@/components/DismissibleBanners';
import { approveLearnedAnswer, rejectLearnedAnswer, retryLearnedCandidate } from './actions';
import { canViewArea } from '@zendori/core';
import NoAccessPanel from '@/components/NoAccessPanel';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { Field } from '@/components/ui/Field';
import { EmptyState, Section, Stat, Stats } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';

type LearnedRow = {
  id: string;
  conversation_id: string | null;
  origin: 'handoff_resolution' | 'draft_correction';
  status: string;
  question: string | null;
  answer: string | null;
  created_at: string;
};

const originLabels: Record<LearnedRow['origin'], string> = {
  handoff_resolution: 'Antwort nach Übergabe',
  draft_correction: 'Korrigierter KI-Entwurf',
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export default async function LearnedAnswersPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'knowledge')) return <NoAccessPanel title="Gelernte Antworten" />;

  const supabase = await createSupabaseServerClient();
  const countByStatus = (status: string) =>
    supabase
      .from('learned_answers')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('status', status);
  const [
    { data: proposedData },
    { data: recentData },
    { count: approvedCountRaw },
    { count: candidateCount },
    { count: errorCount },
  ] = await Promise.all([
    supabase
      .from('learned_answers')
      .select('id, conversation_id, origin, status, question, answer, created_at')
      .eq('org_id', orgId)
      .eq('status', 'proposed')
      .order('created_at', { ascending: true })
      .limit(50),
    supabase
      .from('learned_answers')
      .select('id, conversation_id, origin, status, question, answer, created_at')
      .eq('org_id', orgId)
      .in('status', ['approved', 'error'])
      .order('decided_at', { ascending: false, nullsFirst: false })
      .limit(10),
    countByStatus('approved'),
    countByStatus('candidate'),
    countByStatus('error'),
  ]);

  const proposed = (proposedData ?? []) as LearnedRow[];
  const recent = (recentData ?? []) as LearnedRow[];
  const approvedCount = approvedCountRaw ?? 0;
  const pendingDistill = (candidateCount ?? 0) + (errorCount ?? 0);

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[
          { label: 'Wissen', href: href('/settings/knowledge', { org: orgId }) },
          { label: 'Gelernte Antworten' },
        ]}
        title="Gelernte Antworten"
        subtitle="Vorschläge aus Mitarbeiter-Antworten und korrigierten KI-Entwürfen, die du vor der Übernahme prüfst."
      />

      <div className="page-body">
        <div className="stack stack--lg">
          <DismissibleBanners error={error} notice={notice} />

          <Stats>
            <Stat label="Freigegeben" value={approvedCount} />
            <Stat label="Zur Prüfung" value={proposed.length} />
            <Stat label="In Verarbeitung" value={pendingDistill} />
          </Stats>

          <Callout>
            Damit gelernte Antworten wirken, muss die Wissensdatenbank „Gelernte Antworten“ mit
            deinen Agenten verknüpft sein.{' '}
            <Link href={href('/settings/agents', { org: orgId })}>Unter Agenten verknüpfen</Link>
          </Callout>

          <div>
            <Section
              title="Zur Prüfung"
              help="Antwortet ein Mitarbeiter nach einer Übergabe oder korrigiert er einen KI-Entwurf deutlich, entsteht daraus ein verallgemeinerter, anonymisierter Vorschlag. Erst nach deiner Freigabe nutzt ihn jeder verknüpfte Agent."
            >
              {proposed.length === 0 ? (
                <EmptyState
                  title="Keine offenen Vorschläge"
                  text="Sobald Mitarbeiter in der Inbox übernommene Konversationen beantworten oder KI-Entwürfe korrigieren, erscheinen hier neue Vorschläge."
                />
              ) : (
                <div className="stack form-narrow">
                  {proposed.map((row) => (
                    <div className="kb-proposal" key={row.id}>
                      <div className="muted small">
                        {originLabels[row.origin]} · {formatDate(row.created_at)}
                        {row.conversation_id ? (
                          <>
                            {' · '}
                            <Link
                              href={href('/inbox', {
                                org: orgId,
                                c: row.conversation_id,
                                status: 'all',
                                channel: 'all',
                              })}
                            >
                              Zur Konversation
                            </Link>
                          </>
                        ) : null}
                      </div>
                      <form className="stack" action={approveLearnedAnswer} id={`approve-${row.id}`}>
                        <input type="hidden" name="org" value={orgId} />
                        <input type="hidden" name="id" value={row.id} />
                        <Field label="Frage" htmlFor={`q-${row.id}`}>
                          <input
                            id={`q-${row.id}`}
                            name="question"
                            type="text"
                            required
                            minLength={3}
                            maxLength={500}
                            defaultValue={row.question ?? ''}
                          />
                        </Field>
                        <Field label="Antwort" htmlFor={`a-${row.id}`}>
                          <textarea
                            id={`a-${row.id}`}
                            name="answer"
                            rows={4}
                            required
                            minLength={3}
                            maxLength={4000}
                            defaultValue={row.answer ?? ''}
                          />
                        </Field>
                      </form>
                      {/* every proposal has the same pair of actions — none of them is
                          THE primary action of the page */}
                      <div className="row">
                        <Button type="submit" form={`approve-${row.id}`}>
                          In Wissensdatenbank übernehmen
                        </Button>
                        <form action={rejectLearnedAnswer}>
                          <input type="hidden" name="org" value={orgId} />
                          <input type="hidden" name="id" value={row.id} />
                          <Button type="submit" variant="ghost">
                            Ablehnen
                          </Button>
                        </form>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {recent.length > 0 ? (
              <Section title="Zuletzt entschieden">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Frage</th>
                        <th>Status</th>
                        <th>Herkunft</th>
                        <th aria-label="Aktionen" />
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((row) => (
                        <tr key={row.id}>
                          <td className="kb-break">{row.question ?? '—'}</td>
                          <td>
                            {row.status === 'approved' ? (
                              <Badge tone="success" dot>
                                Freigegeben
                              </Badge>
                            ) : (
                              <Badge tone="danger" dot>
                                Fehler
                              </Badge>
                            )}
                          </td>
                          <td className="muted">{originLabels[row.origin]}</td>
                          <td className="cell-actions">
                            {row.status === 'error' ? (
                              <form action={retryLearnedCandidate}>
                                <input type="hidden" name="org" value={orgId} />
                                <input type="hidden" name="id" value={row.id} />
                                <Button type="submit" size="sm">
                                  Erneut versuchen
                                </Button>
                              </form>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
