import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { Channel, ChannelType } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { listChannels } from '@/lib/inbox/queries';
import { createTestChannel } from '@/app/inbox/actions';
import { createWidgetChannel, updateWidgetTheme, createIntakeAddress } from './actions';
import { DEFAULT_THEME, type WidgetTheme } from '@/lib/widget/session';
import { appUrl } from '@/lib/env';

const channelTypeLabels: Record<ChannelType, string> = {
  chat: 'Chat',
  email: 'E-Mail',
  whatsapp: 'WhatsApp',
  voice: 'Telefon',
};

type WidgetChannelView = {
  id: string;
  name: string;
  publicToken: string;
  theme: WidgetTheme;
};

/** Extracts the widget config from a channel row; returns null for non-widget channels. */
function toWidgetChannelView(channel: Channel): WidgetChannelView | null {
  const config = channel.config as {
    widget?: unknown;
    public_token?: unknown;
    theme?: { color?: unknown; title?: unknown; greeting?: unknown };
  };
  if (config.widget !== true || typeof config.public_token !== 'string') return null;
  const theme = config.theme ?? {};
  return {
    id: channel.id,
    name: channel.name,
    publicToken: config.public_token,
    theme: {
      color: typeof theme.color === 'string' ? theme.color : DEFAULT_THEME.color,
      title: typeof theme.title === 'string' ? theme.title : DEFAULT_THEME.title,
      greeting: typeof theme.greeting === 'string' ? theme.greeting : DEFAULT_THEME.greeting,
    },
  };
}

type IntakeChannelView = {
  id: string;
  name: string;
  address: string;
  isActive: boolean;
};

/** Extracts an inbound-email intake channel; returns null for other channels. */
function toIntakeChannelView(channel: Channel): IntakeChannelView | null {
  if (channel.type !== 'email') return null;
  const config = channel.config as { mode?: unknown; address?: unknown };
  if (config.mode !== 'inbound' || typeof config.address !== 'string') return null;
  return {
    id: channel.id,
    name: channel.name,
    address: config.address,
    isActive: channel.is_active,
  };
}

const textareaStyle: CSSProperties = {
  width: '100%',
  padding: '0.55rem 0.75rem',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: '0.95rem',
  fontFamily: 'inherit',
  background: 'var(--surface)',
  resize: 'vertical',
};

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, orgs } = await requireActiveOrg(org);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const channels = await listChannels(orgId);
  const widgetChannels = channels
    .map(toWidgetChannelView)
    .filter((view): view is WidgetChannelView => view !== null);
  const intakeChannels = channels
    .map(toIntakeChannelView)
    .filter((view): view is IntakeChannelView => view !== null);

  return (
    <div className="shell">
      <header>
        <span className="brand">Zendori</span>
        <Link href={`/inbox?org=${orgId}`}>Zurück zur Inbox</Link>
      </header>

      {error ? (
        <p className="error" style={{ marginBottom: '1.5rem' }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" style={{ marginBottom: '1.5rem' }}>
          {notice}
        </p>
      ) : null}

      <div className="panel">
        <h2>Kanäle — {orgName}</h2>
        {channels.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Noch keine Kanäle vorhanden. Lege unten einen Test-Channel an, um Nachrichten manuell
            einzuspeisen.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Typ</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => (
                <tr key={channel.id}>
                  <td>{channel.name}</td>
                  <td>{channelTypeLabels[channel.type]}</td>
                  <td>
                    {channel.is_active ? (
                      <span className="badge">Aktiv</span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                        Inaktiv
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Chat-Widget</h2>
        <p
          style={{
            fontSize: '0.9rem',
            color: 'var(--text-muted)',
            marginBottom: '1rem',
          }}
        >
          Das Chat-Widget wird mit einem einzigen Script-Tag in beliebige Websites eingebunden.
          Nachrichten aus dem Widget erscheinen als Konversationen in der Inbox. Ausprobieren:{' '}
          <Link href={`/widget-demo?org=${orgId}`}>Widget-Demo</Link>.
        </p>
        <form className="stack" action={createWidgetChannel} style={{ maxWidth: '26rem' }}>
          <input type="hidden" name="org" value={orgId} />
          <div>
            <label htmlFor="widget-name">Name</label>
            <input
              id="widget-name"
              name="name"
              type="text"
              required
              minLength={2}
              maxLength={80}
              placeholder="z. B. Website-Chat zendori.de"
            />
          </div>
          <button className="primary" type="submit">
            Widget-Channel anlegen
          </button>
        </form>
      </div>

      {widgetChannels.map((widget) => (
        <div className="panel" key={widget.id}>
          <h2>Widget — {widget.name}</h2>
          <form className="stack" action={updateWidgetTheme} style={{ maxWidth: '26rem' }}>
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="channelId" value={widget.id} />
            <div>
              <label htmlFor={`widget-color-${widget.id}`}>Farbe</label>
              <input
                id={`widget-color-${widget.id}`}
                name="color"
                type="color"
                defaultValue={widget.theme.color}
              />
            </div>
            <div>
              <label htmlFor={`widget-title-${widget.id}`}>Titel</label>
              <input
                id={`widget-title-${widget.id}`}
                name="title"
                type="text"
                required
                minLength={1}
                maxLength={60}
                defaultValue={widget.theme.title}
              />
            </div>
            <div>
              <label htmlFor={`widget-greeting-${widget.id}`}>Begrüßung</label>
              <textarea
                id={`widget-greeting-${widget.id}`}
                name="greeting"
                rows={3}
                required
                maxLength={300}
                defaultValue={widget.theme.greeting}
                style={textareaStyle}
              />
            </div>
            <button className="primary" type="submit">
              Theme speichern
            </button>
          </form>
          <div style={{ marginTop: '1.25rem' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Embed-Code</span>
            <code className="invite-link">
              {`<script src="${appUrl()}/widget.js" data-zendori-token="${widget.publicToken}" async></script>`}
            </code>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
              Diesen Code auf der Website vor dem schließenden &lt;/body&gt;-Tag einfügen. Der Token
              ist öffentlich — er identifiziert nur den Kanal und enthält keine Geheimnisse.
            </p>
          </div>
        </div>
      ))}

      <div className="panel">
        <h2>E-Mail-Intake-Adressen</h2>
        <p
          style={{
            fontSize: '0.9rem',
            color: 'var(--text-muted)',
            marginBottom: '1rem',
          }}
        >
          An diese Adressen gesendete E-Mails (als Empfänger oder in CC) landen automatisch in der
          Inbox. Ideal für Kontaktformulare beliebiger Websites: einfach die Adresse als Empfänger
          eintragen — kein Code auf der Kundenseite nötig.
        </p>
        {intakeChannels.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Noch keine Intake-Adressen angelegt.
          </p>
        ) : (
          <div style={{ marginBottom: '1.25rem' }}>
            {intakeChannels.map((intake) => (
              <div key={intake.id} style={{ marginBottom: '0.9rem' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                  {intake.name}
                  {intake.isActive ? '' : ' (inaktiv)'}
                </span>
                <code className="invite-link">{intake.address}</code>
              </div>
            ))}
          </div>
        )}
        <form className="stack" action={createIntakeAddress} style={{ maxWidth: '26rem' }}>
          <input type="hidden" name="org" value={orgId} />
          <div>
            <label htmlFor="intake-name">Name</label>
            <input
              id="intake-name"
              name="name"
              type="text"
              required
              minLength={2}
              maxLength={120}
              placeholder="z. B. Kontaktformular strong-energy.eu"
            />
          </div>
          <div>
            <label htmlFor="intake-purpose">Zweck (Kürzel)</label>
            <input
              id="intake-purpose"
              name="purpose"
              type="text"
              required
              maxLength={40}
              placeholder="z. B. kf"
            />
          </div>
          <button className="primary" type="submit">
            Intake-Adresse anlegen
          </button>
        </form>
      </div>

      <div className="panel">
        <h2>Test-Channel anlegen</h2>
        <p
          style={{
            fontSize: '0.9rem',
            color: 'var(--text-muted)',
            marginBottom: '1rem',
          }}
        >
          Ein Test-Channel dient zum manuellen Einspeisen von Nachrichten über den{' '}
          <Link href={`/test-channel?org=${orgId}`}>Test-Channel</Link>. Weitere echte Kanäle
          (WhatsApp, Telefon) folgen in späteren Phasen.
        </p>
        <form className="stack" action={createTestChannel} style={{ maxWidth: '26rem' }}>
          <input type="hidden" name="org" value={orgId} />
          <div>
            <label htmlFor="name">Name</label>
            <input
              id="name"
              name="name"
              type="text"
              required
              minLength={2}
              placeholder="z. B. Test-Kanal Support"
            />
          </div>
          <button className="primary" type="submit">
            Test-Channel anlegen
          </button>
        </form>
      </div>
    </div>
  );
}
