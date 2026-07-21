'use client';

import { useState } from 'react';
import type { AgentKind, AgentMode } from '@zendori/core';

// Kind/mode/threshold interplay for the agent forms (0015):
//   · Voice agents offer only "Reine Annahme" and "Autopilot" — no drafts on a
//     live call — and no confidence threshold (there is no draft gate to tune).
//   · Text agents keep all three modes + the threshold.
// Kind is chosen at creation and immutable afterwards (DB guard) — the edit
// form shows it as static text.

const MODE_OPTIONS: Record<AgentKind, { value: AgentMode; label: string }[]> = {
  text: [
    { value: 'draft_only', label: 'Nur Entwürfe — Vorschläge, ein Mensch prüft und sendet' },
    { value: 'autopilot', label: 'Autopilot — antwortet selbst, wenn er sicher genug ist' },
    { value: 'intake_only', label: 'Reine Annahme — nimmt das Anliegen auf, antwortet nicht' },
  ],
  voice: [
    {
      value: 'intake_only',
      label: 'Reine Annahme — nimmt das Anliegen am Telefon auf und leitet es weiter',
    },
    {
      value: 'autopilot',
      label: 'Autopilot — führt das Gespräch und beantwortet Fragen aus der Wissensdatenbank',
    },
  ],
};

export default function AgentBehaviorFields({
  idPrefix,
  kindFixed,
  defaultMode,
  defaultThreshold,
  defaultHandoffEnabled,
  disabled,
}: {
  idPrefix: string;
  /** Set on edit forms: kind is immutable, shown as static text. Absent = create form with kind select. */
  kindFixed?: AgentKind;
  defaultMode?: AgentMode;
  defaultThreshold?: number;
  /** 0018: per-agent human-handoff master switch (default on). */
  defaultHandoffEnabled?: boolean;
  disabled: boolean;
}) {
  const [kind, setKind] = useState<AgentKind>(kindFixed ?? 'text');
  const options = MODE_OPTIONS[kind];
  const fallbackMode: AgentMode = kind === 'voice' ? 'intake_only' : 'draft_only';
  const effectiveDefault = options.some((o) => o.value === defaultMode)
    ? (defaultMode as AgentMode)
    : fallbackMode;
  // Mode is controlled: the handoff toggle only renders for non-intake modes.
  const [mode, setMode] = useState<AgentMode>(effectiveDefault);

  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-kind`}>Typ</label>
        {kindFixed ? (
          <>
            {/* kind is immutable after creation — display only, not posted */}
            <p style={{ margin: '0.2rem 0 0', fontWeight: 600 }}>
              {kindFixed === 'voice' ? 'Voice-Agent (Telefon)' : 'Text-Agent (Chat, E-Mail, WhatsApp)'}
            </p>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
              Der Typ ist nach dem Anlegen fest.
            </p>
          </>
        ) : (
          <>
            <select
              id={`${idPrefix}-kind`}
              name="kind"
              value={kind}
              disabled={disabled}
              onChange={(e) => {
                const nextKind = e.target.value === 'voice' ? 'voice' : 'text';
                setKind(nextKind);
                // reset an invalid mode when the kind flips
                if (!MODE_OPTIONS[nextKind].some((o) => o.value === mode)) {
                  setMode(nextKind === 'voice' ? 'intake_only' : 'draft_only');
                }
              }}
            >
              <option value="text">Text-Agent — bedient Chat, E-Mail und WhatsApp</option>
              <option value="voice">Voice-Agent — bedient Telefon-Kanäle</option>
            </select>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
              Ein Voice-Agent kann nur Voice-Kanälen zugewiesen werden, ein Text-Agent allen
              anderen. Der Typ ist nach dem Anlegen fest.
            </p>
          </>
        )}
      </div>
      <div>
        <label htmlFor={`${idPrefix}-mode`}>Verhalten</label>
        <select
          id={`${idPrefix}-mode`}
          name="mode"
          value={mode}
          disabled={disabled}
          onChange={(e) => setMode(e.target.value as AgentMode)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {mode !== 'intake_only' ? (
        <div>
          <label
            htmlFor={`${idPrefix}-handoff`}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 400 }}
          >
            <input
              id={`${idPrefix}-handoff`}
              name="handoffEnabled"
              type="checkbox"
              defaultChecked={defaultHandoffEnabled !== false}
              disabled={disabled}
              style={{ width: 'auto' }}
            />
            Übergabe an Menschen bei Unsicherheit
          </label>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
            Aus = bei unsicheren Antworten bleibt der Entwurf ein Vorschlag (Text) bzw. bietet der
            Assistent ein Ticket an (Telefon). Wünscht sich jemand ausdrücklich einen Menschen oder
            fällt ein Eskalations-Begriff, wird IMMER übergeben.
          </p>
        </div>
      ) : null}
      {kind === 'text' ? (
        <div>
          <label htmlFor={`${idPrefix}-threshold`}>Sicherheits-Schwellwert (0–1, nur Autopilot)</label>
          <input
            id={`${idPrefix}-threshold`}
            name="confidenceThreshold"
            type="number"
            min={0}
            max={1}
            step={0.05}
            defaultValue={defaultThreshold ?? 0.7}
            disabled={disabled}
            style={{ maxWidth: '10rem' }}
          />
        </div>
      ) : null}
    </>
  );
}
