'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { AgentKind, AgentMode, EscalationTarget, IntakeField } from '@zendori/core';
import { OptionGroup, SettingRow, type Option } from './ui/Field';
import { Section } from './ui/Layout';

// Kind/mode/threshold interplay for the agent forms (0015):
//   · Voice agents offer only "Reine Annahme" and "Autopilot" — no drafts on a
//     live call.
//   · Text agents keep all three modes.
//   · The confidence threshold steers when the agent stops answering and hands
//     off. It has no meaning in "Reine Annahme" (nothing is answered), so voice
//     shows it only in autopilot; text keeps showing it in every mode (it also
//     gates draft_only handoffs).
// Kind is chosen at creation and immutable afterwards (DB guard) — the edit
// form shows it as static text.
//
// Redesign stage 5: the choices are OptionGroups (kit) instead of selects. The
// kit renders plain, uncontrolled radios, so this component observes them
// through the bubbling change event of its root element and keeps `kind` and
// `mode` in state exactly as before.

const KIND_OPTIONS: Option[] = [
  { value: 'text', title: 'Text-Agent', help: 'Bedient Chat, E-Mail und WhatsApp.' },
  { value: 'voice', title: 'Voice-Agent', help: 'Bedient Telefon-Kanäle.' },
];

const MODE_OPTIONS: Record<AgentKind, (Option & { value: AgentMode })[]> = {
  text: [
    {
      value: 'draft_only',
      title: 'Nur Entwürfe',
      help: 'Der Agent schlägt Antworten vor, ein Mensch prüft und sendet sie.',
    },
    {
      value: 'autopilot',
      title: 'Autopilot',
      help: 'Der Agent antwortet selbst, wenn er sicher genug ist.',
    },
    {
      value: 'intake_only',
      title: 'Reine Annahme',
      help: 'Der Agent nimmt das Anliegen auf und antwortet nicht.',
    },
  ],
  voice: [
    {
      value: 'intake_only',
      title: 'Reine Annahme',
      help: 'Der Agent nimmt das Anliegen am Telefon auf und leitet es weiter.',
    },
    {
      value: 'autopilot',
      title: 'Autopilot',
      help: 'Der Agent führt das Gespräch und beantwortet Fragen aus der Wissensdatenbank.',
    },
  ],
};

const TARGET_OPTIONS: Option[] = [
  {
    value: 'human',
    title: 'An einen Menschen übergeben',
    help: 'Die Konversation wartet in der Inbox, bis ein Mitarbeiter übernimmt oder an den Bot zurückgibt. Telefon: Weiterleitung oder Rückruf.',
  },
  {
    value: 'ticket',
    title: 'Als Ticket aufnehmen',
    help: 'Der Agent bleibt im Gespräch, der Kunde bekommt eine Bestätigung mit Ticketnummer. Telefon: nimmt einen Rückruf auf, leitet nie weiter.',
  },
];

// Voice intake-field checkboxes (0027) in canonical order. Defined locally
// instead of importing INTAKE_FIELDS: this is a client component, and a VALUE
// import from @zendori/core drags core's index (node:crypto via
// standard-webhooks) into the browser bundle — type imports are erased.
const INTAKE_FIELD_OPTIONS: { value: IntakeField; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'phone', label: 'Rückrufnummer' },
  { value: 'email', label: 'E-Mail-Adresse' },
  { value: 'company', label: 'Unternehmen' },
];

export default function AgentBehaviorFields({
  idPrefix,
  kindFixed,
  defaultMode,
  defaultThreshold,
  defaultHandoffEnabled,
  defaultEscalationTarget,
  defaultIntakeFields,
  handoffSettingsHref,
  disabled,
}: {
  idPrefix: string;
  /** Set on edit forms: kind is immutable, shown as static text. Absent = create form with kind choice. */
  kindFixed?: AgentKind;
  defaultMode?: AgentMode;
  defaultThreshold?: number;
  /** 0018: "also escalate on low confidence" (default on). */
  defaultHandoffEnabled?: boolean;
  /** 0031: what an escalation does — live handoff or ticket without a human. */
  defaultEscalationTarget?: EscalationTarget;
  /** 0027: fields a voice agent asks the caller for during ticket intake. */
  defaultIntakeFields?: IntakeField[];
  /** Link to the org-wide handoff rules (Einstellungen → Übergabe und Zeiten). */
  handoffSettingsHref?: string;
  disabled: boolean;
}) {
  const [kind, setKind] = useState<AgentKind>(kindFixed ?? 'text');
  const intakeDefaults = new Set<IntakeField>(defaultIntakeFields ?? ['name', 'phone']);
  const options = MODE_OPTIONS[kind];
  const fallbackMode: AgentMode = kind === 'voice' ? 'intake_only' : 'draft_only';
  const effectiveDefault = options.some((o) => o.value === defaultMode)
    ? (defaultMode as AgentMode)
    : fallbackMode;
  // Mode is controlled: the handoff toggle only renders for non-intake modes.
  const [mode, setMode] = useState<AgentMode>(effectiveDefault);
  const showThreshold = kind === 'text' || mode === 'autopilot';

  // The radios of the kit's OptionGroup are uncontrolled — follow them here.
  function onChoice(event: FormEvent<HTMLDivElement>): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== 'radio') return;
    if (target.name === 'kind') {
      const nextKind: AgentKind = target.value === 'voice' ? 'voice' : 'text';
      setKind(nextKind);
      // reset an invalid mode when the kind flips
      if (!MODE_OPTIONS[nextKind].some((o) => o.value === mode)) {
        setMode(nextKind === 'voice' ? 'intake_only' : 'draft_only');
      }
    } else if (target.name === 'mode') {
      setMode(target.value as AgentMode);
    }
  }

  return (
    <div className="agents-behavior" onChange={onChoice}>
      {kindFixed ? null : (
        <Section title="Typ" help="Der Typ ist nach dem Anlegen fest.">
          <OptionGroup label="Typ" name="kind" value={kind} options={KIND_OPTIONS} disabled={disabled} />
        </Section>
      )}

      <Section title="Antwortmodus" help="Was der Agent mit einer eingehenden Nachricht tut.">
        {/* remount per kind: the option set changes and the default must apply again */}
        <OptionGroup
          key={kind}
          label="Antwortmodus"
          name="mode"
          value={mode}
          options={options}
          disabled={disabled}
        />
        <div>
          {kindFixed ? (
            // kind is immutable after creation — display only, not posted
            <SettingRow label="Typ" help="Der Typ ist nach dem Anlegen fest.">
              <span className="strong">
                {kindFixed === 'voice' ? 'Voice-Agent (Telefon)' : 'Text-Agent (Chat, E-Mail, WhatsApp)'}
              </span>
            </SettingRow>
          ) : null}
          {showThreshold ? (
            <SettingRow
              label="Sicherheits-Schwellwert (0–1)"
              htmlFor={`${idPrefix}-threshold`}
              help={
                kind === 'voice'
                  ? 'Der Agent schätzt im Gespräch selbst ein, wie sicher er ist. Unter diesem Wert antwortet er nicht inhaltlich, sondern eskaliert. Höher ist vorsichtiger, 0 eskaliert nie wegen Unsicherheit.'
                  : 'Unter diesem Wert eskaliert der Agent, auch im Modus „Nur Entwürfe". Im Autopilot bestimmt er außerdem, ab welcher Sicherheit automatisch gesendet wird.'
              }
            >
              {/* render-time truth: a form without the field must not reset the stored value */}
              <input type="hidden" name="thresholdRendered" value="1" />
              <input
                id={`${idPrefix}-threshold`}
                name="confidenceThreshold"
                type="number"
                min={0}
                max={1}
                step={0.05}
                defaultValue={defaultThreshold ?? 0.7}
                disabled={disabled}
              />
            </SettingRow>
          ) : null}
        </div>
      </Section>

      {kind === 'voice' ? (
        <Section
          title="Anliegen-Aufnahme"
          help="Diese Angaben erfragt der Agent, bevor er ein Anliegen als Ticket aufnimmt."
        >
          <fieldset className="fieldset-plain">
            <legend className="sr-only">Abgefragte Angaben bei der Anliegen-Aufnahme</legend>
            {/* render-time truth: a stale form without the checkboxes must not wipe the selection */}
            <input type="hidden" name="intakeFieldsRendered" value="1" />
            {INTAKE_FIELD_OPTIONS.map((option) => (
              <label
                key={option.value}
                htmlFor={`${idPrefix}-intake-${option.value}`}
                className="check-row"
              >
                <input
                  id={`${idPrefix}-intake-${option.value}`}
                  name="intakeFields"
                  type="checkbox"
                  value={option.value}
                  defaultChecked={intakeDefaults.has(option.value)}
                  disabled={disabled}
                />
                {option.label}
              </label>
            ))}
            <p className="field-help">
              Die Rückrufnummer erfragt er nur, wenn sie von der Anrufnummer abweicht. Nicht
              Angehaktes wird nicht aktiv erfragt, aber gespeichert, wenn der Anrufer es von selbst
              nennt.
            </p>
          </fieldset>
        </Section>
      ) : null}

      <Section
        title="Wenn der Agent nicht weiterkommt"
        help="Eskalations-Begriffe und der ausdrückliche Wunsch nach einem Menschen eskalieren immer."
      >
        {/* render-time truth (0027 pattern): a stale form must not reset the target */}
        <input type="hidden" name="escalationTargetRendered" value="1" />
        <OptionGroup
          label="Eskalationsziel"
          name="escalationTarget"
          value={defaultEscalationTarget ?? 'human'}
          options={TARGET_OPTIONS}
          disabled={disabled}
        />
        {mode !== 'intake_only' ? (
          <SettingRow
            label="Auch bei Unsicherheit eskalieren"
            htmlFor={`${idPrefix}-handoff`}
            help="Aus: Eine unsichere Antwort bleibt ein Vorschlag im Posteingang (Text), am Telefon bietet der Assistent ein Ticket an."
          >
            <input
              id={`${idPrefix}-handoff`}
              name="handoffEnabled"
              type="checkbox"
              className="switch"
              defaultChecked={defaultHandoffEnabled !== false}
              disabled={disabled}
            />
          </SettingRow>
        ) : (
          <p className="field-help">
            Reine Annahme: Jede Nachricht wird aufgenommen, je nach Auswahl oben als Übergabe oder
            als Ticket mit Bestätigung.
          </p>
        )}
        {handoffSettingsHref ? (
          <p className="field-help">
            Eskalations-Begriffe, Geschäftszeiten und Bestätigungstexte gelten für alle Agenten.{' '}
            <Link href={handoffSettingsHref}>Übergabe und Zeiten öffnen</Link>
          </p>
        ) : null}
      </Section>
    </div>
  );
}
