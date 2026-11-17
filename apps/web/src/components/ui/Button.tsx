// Button (redesign stage 3, docs/design-redesign.md §4). One component for
// real buttons and for links that look like buttons:
//   <Button type="submit" variant="primary">Speichern</Button>
//   <Button href={`?panel=new&org=${orgId}`} variant="primary" icon="plus">Neuer Kanal</Button>
// Rules: at most ONE primary button per view; destructive actions use
// variant="danger" and live in a Menu or behind ConfirmDeleteButton.
// Server component — no state. A submit button outside its <form> (drawer
// footer) points at it with the native `form="form-id"` attribute.
import type { ComponentProps, ReactNode } from 'react';
import Link from 'next/link';
import Icon, { type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface Common {
  /** Default 'secondary'. */
  variant?: ButtonVariant;
  /** 'md' = 36px (default). 'sm' = 32px, only inside toolbars, tables and cards. */
  size?: 'md' | 'sm';
  /** Leading icon. */
  icon?: IconName;
  /** Square icon-only button; needs an aria-label. */
  iconOnly?: boolean;
  className?: string;
  children?: ReactNode;
}

type AsButton = Common &
  Omit<ComponentProps<'button'>, 'className' | 'children' | 'type'> & {
    href?: undefined;
    /** Required on purpose: an accidental submit or a dead submit are both silent bugs. */
    type: 'button' | 'submit' | 'reset';
  };

type AsLink = Common &
  Omit<ComponentProps<typeof Link>, 'className' | 'children' | 'href'> & { href: string };

export function buttonClass({
  variant = 'secondary',
  size = 'md',
  iconOnly = false,
  className,
}: Pick<Common, 'variant' | 'size' | 'iconOnly' | 'className'>): string {
  return [
    'btn',
    `btn--${variant}`,
    size === 'sm' ? 'btn--sm' : '',
    iconOnly ? 'btn--icon' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

export default function Button(props: AsButton | AsLink) {
  const { variant, size, icon, iconOnly, className, children, ...rest } = props;
  const classes = buttonClass({ variant, size, iconOnly, className });
  const content = (
    <>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </>
  );
  if (rest.href !== undefined) {
    return (
      <Link {...rest} className={classes}>
        {content}
      </Link>
    );
  }
  return (
    <button {...rest} className={classes}>
      {content}
    </button>
  );
}
