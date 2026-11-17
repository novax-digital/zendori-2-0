// The frame of every page outside the app chrome that asks for one thing:
// sign in, create the organisation, set a password, pick an organisation.
// Wordmark on a quiet ground, one outlined card. No hooks — usable from
// server and client pages.
import type { ReactNode } from 'react';

export default function AuthCard({
  title,
  subtitle,
  wide = false,
  footer,
  children,
}: {
  title: ReactNode;
  /** One sentence below the title. */
  subtitle?: ReactNode;
  /** A wider card for lists (organisation chooser). */
  wide?: boolean;
  /** Shown below the card, e.g. a sign-out button. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="auth">
      <div className={`auth-wrap${wide ? ' auth-wrap--wide' : ''}`}>
        <div className="auth-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="onlight" src="/brand/logo-onlight.svg" alt="Zendori" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="ondark" src="/brand/logo-ondark.svg" alt="Zendori" />
        </div>
        <div className="auth-card">
          <div>
            <h1>{title}</h1>
            {subtitle ? <p className="auth-sub">{subtitle}</p> : null}
          </div>
          {children}
        </div>
        {footer}
      </div>
    </main>
  );
}
