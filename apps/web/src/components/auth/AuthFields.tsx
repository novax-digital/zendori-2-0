'use client';

// Inputs and submit button of the sign-in pages (AuthSplit). Client-side only
// for the two bits of interaction: showing the password and the pending state
// of the submit button (useFormStatus for server-action forms, or an explicit
// `pending` for forms handled in the browser).
import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import Icon, { type IconName } from '@/components/ui/Icon';

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className' | 'type'>;

export function AuthTextField({
  id,
  label,
  icon,
  type = 'text',
  ...input
}: InputProps & { id: string; label: string; icon: IconName; type?: 'text' | 'email' }) {
  return (
    <div className="authx-field">
      <label htmlFor={id}>{label}</label>
      <div className="authx-input">
        <Icon name={icon} size={17} className="authx-input-icon" />
        <input id={id} type={type} {...input} />
      </div>
    </div>
  );
}

export function AuthPasswordField({
  id,
  label,
  aside,
  ...input
}: InputProps & { id: string; label: string; /** Right of the label, e.g. a link. */ aside?: ReactNode }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="authx-field">
      <div className="authx-label-row">
        <label htmlFor={id}>{label}</label>
        {aside}
      </div>
      <div className="authx-input authx-input--toggle">
        <Icon name="lock" size={17} className="authx-input-icon" />
        <input id={id} type={visible ? 'text' : 'password'} {...input} />
        <button
          type="button"
          className="authx-eye"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Passwort verbergen' : 'Passwort anzeigen'}
          aria-pressed={visible}
          aria-controls={id}
        >
          <Icon name={visible ? 'eyeOff' : 'eye'} size={17} />
        </button>
      </div>
    </div>
  );
}

export function AuthSubmit({
  label,
  pendingLabel,
  pending: pendingProp,
}: {
  label: string;
  pendingLabel: string;
  /** For browser-handled forms; server-action forms use the form status. */
  pending?: boolean;
}) {
  const status = useFormStatus();
  const pending = pendingProp ?? status.pending;
  return (
    <button type="submit" className="authx-submit" disabled={pending} aria-busy={pending}>
      {pending ? <span className="authx-spinner" aria-hidden="true" /> : null}
      <span>{pending ? pendingLabel : label}</span>
      {pending ? null : <Icon name="arrowRight" size={17} />}
    </button>
  );
}
