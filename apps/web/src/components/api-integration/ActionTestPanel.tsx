'use client';

// "Testlauf" of a data action (Phase 13). The values are sent to a server
// action that queues a run; the WORKER performs the call, so the test uses the
// same code path and egress IP as a real agent call. This panel polls the run
// until it is finished.
import { useEffect, useRef, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import {
  getActionRun,
  startActionTest,
  type ActionRunView,
} from '@/app/settings/integrations/api/actions';
import {
  CONTEXT_KEY_LABELS,
  RUN_ERROR_LABELS,
  RUN_STATE_LABELS,
  RUN_STATE_TONES,
} from '@/lib/api-integration/labels';

export interface TestParam {
  key: string;
  /** 'agent' | 'context' — fixed parameters need no test value. */
  source: string;
  required: boolean;
  description: string;
  contextKey: string | null;
}

const POLL_MS = 1_000;
const MAX_POLLS = 30;

export default function ActionTestPanel({
  orgId,
  actionId,
  params,
}: {
  orgId: string;
  actionId: string;
  params: TestParam[];
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [run, setRun] = useState<ActionRunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setRun(null);
    try {
      const started = await startActionTest(orgId, actionId, values);
      if ('error' in started) {
        setError(started.error);
        return;
      }
      for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (cancelled.current) return;
        const current = await getActionRun(orgId, started.runId);
        if (cancelled.current) return;
        if (current) {
          setRun(current);
          if (current.state === 'succeeded' || current.state === 'failed') return;
        }
      }
      setError(
        'Der Lauf wurde noch nicht ausgeführt. Läuft der Worker in der aktuellen Version? Der Lauf bleibt in der Warteschlange und erscheint im Protokoll der Verbindung.'
      );
    } catch {
      setError('Testlauf konnte nicht gestartet werden.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {params.length === 0 ? (
        <p className="muted small">Diese Aktion braucht keine Eingaben.</p>
      ) : (
        params.map((param) => (
          <div className="field" key={param.key}>
            <label htmlFor={`test-${param.key}`}>
              <span className="mono">{param.key}</span>
              {param.required ? '' : ' (optional)'}
            </label>
            <input
              id={`test-${param.key}`}
              type="text"
              value={values[param.key] ?? ''}
              onChange={(event) =>
                setValues((current) => ({ ...current, [param.key]: event.target.value }))
              }
            />
            <p className="field-help">
              {param.source === 'context'
                ? `Im echten Gespräch setzt Zendori diesen Wert: ${
                    CONTEXT_KEY_LABELS[param.contextKey ?? ''] ?? param.contextKey ?? 'Kontext'
                  }.`
                : param.description || 'Wert, den sonst der Agent aus dem Gespräch übernimmt.'}
            </p>
          </div>
        ))
      )}

      <div>
        <Button
          type="button"
          variant="primary"
          icon="flask"
          disabled={busy}
          onClick={() => void start()}
        >
          {busy ? 'Testlauf läuft …' : 'Testlauf starten'}
        </Button>
      </div>

      {error ? <Callout tone="danger">{error}</Callout> : null}

      {run ? (
        <div className="stack stack--sm">
          <div className="row">
            <Badge tone={RUN_STATE_TONES[run.state] ?? 'neutral'} dot>
              {RUN_STATE_LABELS[run.state] ?? run.state}
            </Badge>
            {run.httpStatus !== null ? (
              <span className="muted small">HTTP {run.httpStatus}</span>
            ) : null}
            {run.latencyMs !== null ? (
              <span className="muted small">{run.latencyMs} ms</span>
            ) : null}
          </div>
          {run.errorCode ? (
            <p className="small">{RUN_ERROR_LABELS[run.errorCode] ?? run.errorCode}</p>
          ) : null}
          {run.result !== null && run.result !== undefined ? (
            <>
              <span className="field-label">
                {run.state === 'succeeded'
                  ? 'Das sieht der Agent (nur freigegebene Antwortfelder)'
                  : 'Antwort des Endsystems (Auszug)'}
              </span>
              <code className="code-block run-result">{JSON.stringify(run.result, null, 2)}</code>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
