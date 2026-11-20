// Phase 13 — data-action runs of the open conversation, above the composer.
// A run waiting for confirmation shows what would be sent and two buttons;
// finished runs are a compact history line. Server component: the forms post
// to a server action, live updates arrive through RealtimeRefresher.
import { decideActionRun } from '@/app/inbox/action-runs';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import {
  RUN_ERROR_LABELS,
  RUN_STATE_LABELS,
  RUN_STATE_TONES,
  formatDateTime,
} from '@/lib/api-integration/labels';
import type { ConversationActionRun } from '@/lib/api-integration/queries';

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Short one-line summary of a finished run's mapped result. */
function resultSummary(result: unknown): string | null {
  if (result === null || result === undefined) return null;
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

export default function ActionRuns({
  runs,
  orgId,
  conversationId,
  canDecide,
  filterStatus,
  filterChannel,
  filterQ,
}: {
  runs: ConversationActionRun[];
  orgId: string;
  conversationId: string;
  /** False for members without inbox edit rights: they see the run, not the buttons. */
  canDecide: boolean;
  filterStatus: string;
  filterChannel: string;
  filterQ: string;
}) {
  if (runs.length === 0) return null;
  const pending = runs.filter((run) => run.state === 'pending_approval');
  const history = runs.filter((run) => run.state !== 'pending_approval');

  const hidden = (runId: string, decision: 'approve' | 'reject') => (
    <>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="decision" value={decision} />
      <input type="hidden" name="filterStatus" value={filterStatus} />
      <input type="hidden" name="filterChannel" value={filterChannel} />
      <input type="hidden" name="filterQ" value={filterQ} />
    </>
  );

  return (
    <div className="inbox-actions-block">
      {pending.map((run) => (
        <div key={run.id} className="inbox-action-run inbox-action-run--pending">
          <div className="inbox-action-run-head">
            <span className="inbox-action-run-title">
              <Icon name="sparkle" size={14} />
              {run.action?.label ?? 'Aktion'}
            </span>
            <Badge tone="warn" dot>
              Wartet auf Bestätigung
            </Badge>
          </div>
          <p className="small muted">
            Der Agent möchte diese Aktion in eurem System ausführen. Es wurde noch nichts gesendet.
          </p>
          {Object.keys(run.args).length > 0 ? (
            <dl className="inbox-action-run-args">
              {Object.entries(run.args).map(([key, value]) => (
                <div key={key}>
                  <dt className="mono">{key}</dt>
                  <dd>{formatValue(value)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {canDecide ? (
            <div className="row">
              <form action={decideActionRun}>
                {hidden(run.id, 'approve')}
                <Button type="submit" variant="primary" size="sm">
                  Ausführen
                </Button>
              </form>
              <form action={decideActionRun}>
                {hidden(run.id, 'reject')}
                <Button type="submit" size="sm">
                  Verwerfen
                </Button>
              </form>
            </div>
          ) : null}
        </div>
      ))}

      {history.length > 0 ? (
        <details
          className="inbox-action-history"
          open={pending.length === 0 && history.length <= 2}
        >
          <summary>Aktionen des Agenten ({history.length})</summary>
          <ul>
            {history.map((run) => {
              const summary = run.state === 'succeeded' ? resultSummary(run.result) : null;
              return (
                <li key={run.id}>
                  <div className="row">
                    <span className="strong small">{run.action?.label ?? 'Aktion'}</span>
                    <Badge tone={RUN_STATE_TONES[run.state] ?? 'neutral'} dot>
                      {RUN_STATE_LABELS[run.state] ?? run.state}
                    </Badge>
                    <span className="muted small">{formatDateTime(run.createdAt)}</span>
                  </div>
                  {run.errorCode ? (
                    <p className="small muted">
                      {RUN_ERROR_LABELS[run.errorCode] ?? run.errorCode}
                      {run.httpStatus !== null ? ` (HTTP ${run.httpStatus})` : ''}
                    </p>
                  ) : summary ? (
                    <p className="small muted mono inbox-action-run-result">{summary}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
