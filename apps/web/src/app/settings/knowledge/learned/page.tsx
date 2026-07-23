// Review queue for the learning loop ("Gelernte Antworten", migration 0020):
// distilled, PII-free Q&A proposals wait here for human approval. Approving
// (optionally after editing) compiles all approved pairs into the per-org
// learned-answers CSV source, which the standard pipeline indexes — one chunk
// per pair. Members review (content management is member-level, like sources).
import Link from 'next/link';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import DismissibleBanners from '@/components/DismissibleBanners';
import { approveLearnedAnswer, rejectLearnedAnswer, retryLearnedCandidate } from './actions';

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
  const { orgId } = await requireActiveOrg(org);

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

  const backHref = `/settings/knowledge?org=${orgId}`;

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Gelernte Antworten</h1>
        <p>
          Wenn ein Mitarbeiter nach einer Übergabe antwortet oder einen KI-Entwurf deutlich
          korrigiert, destilliert Zendori daraus einen verallgemeinerten, anonymisierten
          Frage-Antwort-Vorschlag. Erst nach deiner Freigabe wandert er in die Wissensdatenbank
          „Gelernte Antworten" — ab dann nutzt ihn jeder verknüpfte Agent.{' '}
          <Link href={backHref}>← Zurück zur Wissensdatenbank</Link>
        </p>
      </div>

      <DismissibleBanners error={error} notice={notice} style={{ marginBottom: '1.5rem' }} />

      <div className="panel">
        <h2>Überblick</h2>
        <p className="help">
          {approvedCount} freigegeben · {proposed.length} zur Prüfung · {pendingDistill > 0
            ? `${pendingDistill} in Verarbeitung`
            : 'nichts in Verarbeitung'}
          . Damit gelernte Antworten wirken, muss die Wissensdatenbank „Gelernte Antworten" unter
          Einstellungen → Agenten mit deinen Agenten verknüpft sein.
        </p>
      </div>

      {proposed.length === 0 ? (
        <div className="panel">
          <h2>Keine offenen Vorschläge</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Sobald Mitarbeiter in der Inbox übernommene Konversationen beantworten oder
            KI-Entwürfe korrigieren, erscheinen hier neue Lern-Vorschläge.
          </p>
        </div>
      ) : (
        proposed.map((row) => (
          <div className="panel" key={row.id}>
            <p className="hint" style={{ marginBottom: '0.6rem' }}>
              {originLabels[row.origin]} · {formatDate(row.created_at)}
              {row.conversation_id ? (
                <>
                  {' · '}
                  <Link href={`/inbox?org=${orgId}&c=${row.conversation_id}&status=all&channel=all`}>
                    Zur Konversation
                  </Link>
                </>
              ) : null}
            </p>
            <form className="stack" action={approveLearnedAnswer} id={`approve-${row.id}`}>
              <input type="hidden" name="org" value={orgId} />
              <input type="hidden" name="id" value={row.id} />
              <div>
                <label htmlFor={`q-${row.id}`}>Frage</label>
                <input
                  id={`q-${row.id}`}
                  name="question"
                  type="text"
                  required
                  minLength={3}
                  maxLength={500}
                  defaultValue={row.question ?? ''}
                />
              </div>
              <div>
                <label htmlFor={`a-${row.id}`}>Antwort</label>
                <textarea
                  id={`a-${row.id}`}
                  name="answer"
                  rows={4}
                  required
                  minLength={3}
                  maxLength={4000}
                  defaultValue={row.answer ?? ''}
                />
              </div>
            </form>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
              <button className="primary" type="submit" form={`approve-${row.id}`}>
                In Wissensdatenbank übernehmen
              </button>
              <form action={rejectLearnedAnswer}>
                <input type="hidden" name="org" value={orgId} />
                <input type="hidden" name="id" value={row.id} />
                <button className="ghost" type="submit">
                  Ablehnen
                </button>
              </form>
            </div>
          </div>
        ))
      )}

      {recent.length > 0 ? (
        <div className="panel">
          <h2>Zuletzt entschieden</h2>
          <table>
            <thead>
              <tr>
                <th>Frage</th>
                <th>Status</th>
                <th>Quelle</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row) => (
                <tr key={row.id}>
                  <td style={{ wordBreak: 'break-word' }}>{row.question ?? '—'}</td>
                  <td>
                    {row.status === 'approved' ? (
                      <span className="badge badge--success">Freigegeben</span>
                    ) : (
                      <span className="badge badge--danger">Fehler</span>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    {originLabels[row.origin]}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {row.status === 'error' ? (
                      <form action={retryLearnedCandidate} style={{ display: 'inline-block' }}>
                        <input type="hidden" name="org" value={orgId} />
                        <input type="hidden" name="id" value={row.id} />
                        <button className="ghost" type="submit">
                          Erneut versuchen
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
