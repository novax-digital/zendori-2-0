// Badge (redesign stage 3): THE status pill — 22px high, radius 6, 12/500.
// One system for every status; never build a second pill style.
//   <Badge tone="success" dot>Aktiv</Badge>
// Channel badges keep using channelBadgeClass() from '@/lib/inbox/channel-badge'.
import type { ReactNode } from 'react';

export type BadgeTone =
  | 'neutral'
  | 'muted'
  | 'accent'
  | 'info'
  | 'success'
  | 'warn'
  | 'danger'
  | 'hubspot';

export default function Badge({
  tone = 'neutral',
  dot = false,
  title,
  className,
  children,
}: {
  tone?: BadgeTone;
  /** Leading status dot — use it for lifecycle states (open, waiting, done). */
  dot?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const classes = [
    'badge',
    tone === 'neutral' ? '' : `badge--${tone}`,
    dot ? 'badge--dot' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}
