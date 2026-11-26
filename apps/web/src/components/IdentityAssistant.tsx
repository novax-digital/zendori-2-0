'use client';

// "Mit KI erstellen" below the identity field of an agent (migration 0049): the
// member types a few notes, the WORKER writes a suggested identity, and this
// panel shows it to take over or to drop. Taking over only fills the field —
// the agent changes when the form is saved.
//
// The request goes through a server action that queues it; this panel then
// reads the row until it is finished (same pattern as ActionTestPanel).
import { useEffect, useId, useRef, useState } from 'react';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { getIdentitySuggestion, startIdentitySuggestion } from '@/app/settings/agents/actions';

const POLL_MS = 1_000;
/** A suggestion takes about 10 seconds; after this long something is wrong. */
const MAX_POLLS = 75;
const MIN_NOTES = 10;
const MAX_NOTES = 4000;

const NOTES_PLACEHOLDER =
  'z. B. Kundenservice für unseren Onlineshop für Solaranlagen. Kunden duzen, kurz und freundlich antworten. Keine Preise oder Liefertermine zusagen, bei Reklamationen an das Team verweisen.';

const FAILED = 'Der Vorschlag konnte gerade nicht erstellt werden. Bitte versuche es noch einmal.';
const TOO_SLOW = 'Das hat zu lange gedauert. Bitte versuche es noch einmal.';

export default function IdentityAssistant({
  orgId,
  textareaId,
  nameInputId,
  kind,
}: {
  orgId: string;
  /** The identity field this panel fills. */
  textareaId: string;
  /** The agent's name field, read when the suggestion is asked for. */
  nameInputId: string;
  /** Fixed for an existing agent; a new agent's kind is read from its form. */
  kind?: 'text' | 'voice';
}) {
  const notesId = useId();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [hasIdentity, setHasIdentity] = useState(false);
  const [rework, setRework] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  /** The field's text before a suggestion replaced it; null = nothing to undo. */
  const [previous, setPrevious] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const field = (): HTMLTextAreaElement | null =>
    document.getElementById(textareaId) as HTMLTextAreaElement | null;

  const fill = (text: string): void => {
    const textarea = field();
    if (!textarea) return;
    textarea.value = text;
    // notify listeners (the uncontrolled field simply takes the value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  };

  const openPanel = (): void => {
    setHasIdentity((field()?.value.trim().length ?? 0) > 0);
    setRework(true);
    setError(null);
    setSuggestion(null);
    setPrevious(null);
    setOpen(true);
  };

  const start = async (): Promise<void> => {
    const textarea = field();
    const current = textarea?.value.trim() ?? '';
    const name = (document.getElementById(nameInputId) as HTMLInputElement | null)?.value ?? '';
    // a new agent: the kind chosen in the form the field belongs to
    const chosen = textarea?.form?.elements.namedItem('kind');
    const formKind = chosen && 'value' in chosen ? String(chosen.value) : '';
    const agentKind = kind ?? (formKind === 'voice' ? 'voice' : 'text');

    setBusy(true);
    setError(null);
    setSuggestion(null);
    try {
      const started = await startIdentitySuggestion(orgId, {
        kind: agentKind,
        name,
        notes,
        current: hasIdentity && rework && current.length > 0 ? current : null,
      });
      if ('error' in started) {
        setError(started.error);
        return;
      }
      for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (cancelled.current) return;
        const request = await getIdentitySuggestion(orgId, started.requestId);
        if (cancelled.current) return;
        if (request?.state === 'succeeded' && request.result) {
          setSuggestion(request.result);
          return;
        }
        if (request?.state === 'failed') {
          setError(
            request.errorCode === 'expired' || request.errorCode === 'stale' ? TOO_SLOW : FAILED
          );
          return;
        }
      }
      setError(TOO_SLOW);
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  };

  const takeOver = (): void => {
    if (suggestion === null) return;
    setPrevious(field()?.value ?? '');
    fill(suggestion);
    setSuggestion(null);
    setOpen(false);
  };

  if (!open) {
    return (
      <div className="ai-assist-bar">
        <Button type="button" size="sm" icon="sparkle" onClick={openPanel}>
          Mit KI erstellen
        </Button>
        {previous !== null ? (
          <span className="muted small">
            Vorschlag übernommen — er gilt erst nach dem Speichern.{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                fill(previous);
                setPrevious(null);
              }}
            >
              Rückgängig
            </button>
          </span>
        ) : null}
      </div>
    );
  }

  const notesLength = notes.trim().length;
  return (
    <div className="ai-assist">
      <div className="field">
        <label htmlFor={notesId}>Was soll der Agent tun? Ein paar Stichpunkte genügen.</label>
        {/* no name: these notes are not part of the agent form */}
        <textarea
          id={notesId}
          rows={4}
          maxLength={MAX_NOTES}
          value={notes}
          disabled={busy}
          placeholder={NOTES_PLACEHOLDER}
          onChange={(event) => setNotes(event.target.value)}
        />
        <p className="field-help">
          Hilfreich sind: Aufgabe, Anrede (du oder Sie), Tonfall und was der Agent nicht tun oder
          zusagen darf. Die KI kennt nur, was hier steht.
        </p>
      </div>

      {hasIdentity ? (
        <label className="ai-assist-check">
          <input
            type="checkbox"
            checked={rework}
            disabled={busy}
            onChange={(event) => setRework(event.target.checked)}
          />
          <span>Den vorhandenen Text als Grundlage nehmen und überarbeiten</span>
        </label>
      ) : null}

      {error ? <Callout tone="danger">{error}</Callout> : null}

      {suggestion !== null ? (
        <>
          <div className="ai-assist-result" aria-live="polite">
            {suggestion}
          </div>
          <p className="field-help">
            Bitte lies den Vorschlag, bevor du ihn übernimmst. Übernehmen ersetzt den Text im Feld
            {hasIdentity ? ' — das lässt sich danach rückgängig machen' : ''}; gültig wird er erst
            mit dem Speichern.
          </p>
          <div className="row">
            <Button type="button" size="sm" icon="check" onClick={takeOver}>
              Übernehmen
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void start()}>
              Neu erstellen
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Verwerfen
            </Button>
          </div>
        </>
      ) : (
        <div className="row">
          <Button
            type="button"
            size="sm"
            icon="sparkle"
            disabled={busy || notesLength < MIN_NOTES}
            onClick={() => void start()}
          >
            {busy ? 'Vorschlag wird geschrieben …' : 'Vorschlag erstellen'}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
            Abbrechen
          </Button>
          {busy ? <span className="muted small">Das dauert etwa 10 Sekunden.</span> : null}
        </div>
      )}
    </div>
  );
}
