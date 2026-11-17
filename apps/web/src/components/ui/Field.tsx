// Form building blocks (redesign stage 3). Server components — they only
// arrange label, control and help text; the control itself is a plain
// <input>/<select>/<textarea> styled globally.
import type { ReactNode } from 'react';
import Link from 'next/link';

/**
 * Label above the control, help or error below.
 *   <Field label="Name" htmlFor="ch-name" help="So erscheint der Kanal in der Inbox.">
 *     <input id="ch-name" name="name" type="text" required />
 *   </Field>
 * Forms are at most 720px wide (.form-narrow). With `error`, also set
 * aria-invalid on the control.
 */
export function Field({
  label,
  htmlFor,
  help,
  error,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  help?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : help ? (
        <p className="field-help">{help}</p>
      ) : null}
    </div>
  );
}

/**
 * One setting per row: label + one-line help on the left, the control on the
 * right, a line below. For switches, short selects and number fields.
 *   <SettingRow label="Auch bei Unsicherheit eskalieren" help="…" htmlFor="handoff">
 *     <input id="handoff" name="handoffEnabled" type="checkbox" className="switch" />
 *   </SettingRow>
 */
export function SettingRow({
  label,
  help,
  htmlFor,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        {htmlFor ? (
          <label htmlFor={htmlFor}>{label}</label>
        ) : (
          <span className="setting-row-label">{label}</span>
        )}
        {help ? <p className="field-help">{help}</p> : null}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

export interface Option {
  value: string;
  title: ReactNode;
  help?: ReactNode;
  /** Link mode: the option navigates (URL-driven choice) instead of being a radio. */
  href?: string;
  disabled?: boolean;
}

/**
 * 2–6 alternatives that need an explanation each, in one outlined group.
 * Radio mode (default): a real radio group inside a <form>.
 *   <OptionGroup label="Antwortmodus" name="mode" value={agent.mode} options={…} />
 * Link mode (every option has `href`): the choice lives in the URL, e.g. the
 * channel type inside the "Neuer Kanal" drawer — the page then renders the
 * fields of the chosen type on the server.
 */
export function OptionGroup({
  label,
  name,
  value,
  options,
  disabled = false,
}: {
  /** Accessible name of the group. */
  label: string;
  /** Radio name; omit in link mode. */
  name?: string;
  /** Selected value. */
  value?: string;
  options: Option[];
  disabled?: boolean;
}) {
  return (
    <div className="option-group" role={name ? 'radiogroup' : 'group'} aria-label={label}>
      {options.map((option) => {
        const text = (
          <span className="option-text">
            <span className="option-title">{option.title}</span>
            {option.help ? <span className="option-help">{option.help}</span> : null}
          </span>
        );
        if (option.href) {
          const selected = option.value === value;
          return (
            <Link
              key={option.value}
              href={option.href}
              // the choice re-renders the same view (often an open drawer)
              scroll={false}
              className={`option${selected ? ' option--selected' : ''}`}
              aria-current={selected ? 'true' : undefined}
            >
              <span className="option-mark" aria-hidden="true" />
              {text}
            </Link>
          );
        }
        return (
          <label key={option.value} className="option">
            <input
              type="radio"
              name={name}
              value={option.value}
              defaultChecked={option.value === value}
              disabled={disabled || option.disabled}
            />
            {text}
          </label>
        );
      })}
    </div>
  );
}
