// Split-screen frame of the sign-in pages (login, password reset, invite
// password): a dark brand showcase on the left — headline, a glass card with a
// sample conversation the KI-Agent answered, trust line — and a calm form
// column on the right. Below 960px only the form column remains (with the
// logo on top). Server component without hooks; styles in app/styles/auth.css.
import type { ReactNode } from 'react';
import Icon, { type IconName } from '@/components/ui/Icon';
import { sora } from '@/lib/fonts';

const TRUST: { icon: IconName; label: string }[] = [
  { icon: 'shield', label: 'DSGVO · Hosting in der EU' },
  { icon: 'channels', label: 'Telefon, WhatsApp, Chat, E-Mail' },
  { icon: 'team', label: 'Übergabe an dein Team' },
];

function Showcase() {
  return (
    <aside className="authx-showcase" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="authx-logo" src="/brand/logo-ondark.svg" alt="" />

      <div className="authx-pitch">
        <p className="authx-eyebrow">Willkommen bei Zendori</p>
        <p className="authx-headline">
          Jede Anfrage.
          <br />
          <em>Ein Posteingang.</em>
        </p>
        <p className="authx-lead">
          Dein KI-Agent beantwortet, was er weiß – und übergibt den Rest nahtlos an dein Team.
        </p>

        <div className="authx-glass">
          <div className="authx-glass-head">
            <span className="authx-glass-channel">
              <Icon name="whatsapp" size={14} />
              WhatsApp
            </span>
            <span>gerade eben</span>
          </div>
          <p className="authx-bubble authx-bubble--in">Hallo, habt ihr am Samstag geöffnet?</p>
          <p className="authx-bubble authx-bubble--out">
            Ja, samstags sind wir von 9 bis 14 Uhr da. Soll ich dir direkt einen Termin
            eintragen?
          </p>
          <div className="authx-glass-foot">
            <Icon name="check" size={13} />
            Automatisch beantwortet · in 4 Sekunden
          </div>
        </div>
      </div>

      <ul className="authx-trust">
        {TRUST.map((item) => (
          <li key={item.label}>
            <Icon name={item.icon} size={14} />
            {item.label}
          </li>
        ))}
      </ul>
    </aside>
  );
}

export default function AuthSplit({
  chip,
  title,
  subtitle,
  footer,
  children,
}: {
  /** Small label above the title ("Anmeldung"). */
  chip?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Below the form, e.g. "Noch kein Zugang?". */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className={`authx ${sora.variable}`}>
      <Showcase />
      <section className="authx-main">
        <div className="authx-panel">
          <div className="authx-mobile-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="onlight" src="/brand/logo-onlight.svg" alt="Zendori" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="ondark" src="/brand/logo-ondark.svg" alt="Zendori" />
          </div>
          {chip ? (
            <span className="authx-chip">
              <Icon name="sparkle" size={13} />
              {chip}
            </span>
          ) : null}
          <h1 className="authx-title">{title}</h1>
          {subtitle ? <p className="authx-sub">{subtitle}</p> : null}
          <div className="authx-body">{children}</div>
          {footer ? <div className="authx-footer">{footer}</div> : null}
        </div>
        <nav className="authx-legal" aria-label="Rechtliches">
          <a href="https://zendori.ai/impressum">Impressum</a>
          <a href="https://zendori.ai/datenschutzerklaerung">Datenschutz</a>
          <a href="https://zendori.ai">zendori.ai</a>
        </nav>
      </section>
    </main>
  );
}
