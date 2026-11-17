// Callout (redesign stage 3): an inline message box — icon, text, optional
// action on the right. Replaces the .notice / .error paragraphs.
//   <Callout tone="warn">Diesem Kanal ist kein Agent zugewiesen.</Callout>
// Tones: info (neutral, default) · success · warn · danger.
// Server component; DismissibleBanners passes its close button as `action`.
import type { ReactNode } from 'react';
import Icon, { type IconName } from './Icon';

export type CalloutTone = 'info' | 'success' | 'warn' | 'danger';

const ICON: Record<CalloutTone, IconName> = {
  info: 'info',
  success: 'success',
  warn: 'warning',
  danger: 'error',
};

export default function Callout({
  tone = 'info',
  title,
  action,
  className,
  children,
}: {
  tone?: CalloutTone;
  /** Optional bold first line. */
  title?: ReactNode;
  /** Button or link shown on the right (e.g. dismiss). */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`callout callout--${tone}${className ? ` ${className}` : ''}`}
      // errors interrupt, everything else is announced politely
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <Icon name={ICON[tone]} className="callout-icon" />
      <div className="callout-body">
        {title ? <div className="callout-title">{title}</div> : null}
        {children}
      </div>
      {action ? <div className="callout-action">{action}</div> : null}
    </div>
  );
}
