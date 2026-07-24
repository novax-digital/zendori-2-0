// Channels OVERVIEW (two-level layout, owner 2026-07-24): ONE table of all
// channels — name (links to /settings/channels/[channelId]), type, identifier,
// agent, status toggle. Creating new channels lives below in the type gallery
// (tiles open ONLY the create form for that type). All per-channel settings
// moved to the detail page.
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Channel, ChannelKind } from '@zendori/core';
import { canViewArea, isAdminRole } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { listChannels } from '@/lib/inbox/queries';
import { createTestChannel } from '@/app/inbox/actions';
import {
  createWidgetChannel,
  createIntakeAddress,
  createWhatsappTwilioChannel,
} from './actions';
import ChannelGallery, { type TileKey, type TileMeta } from '@/components/ChannelGallery';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import { appUrl } from '@/lib/env';
import { countChannelsByKind, loadChannelLimits } from '@/lib/channel-limits';
import {
  ActiveToggle,
  FLAVOR_LABELS,
  channelFlavor,
  channelIdentifier,
  listAgentOptions,
} from './shared';

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, orgs, role, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'channels')) return <NoAccessPanel title="Kanäle" />;
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const isOwner = isAdminRole(role);

  const [channels, agentOptions, limits] = await Promise.all([
    listChannels(orgId),
    listAgentOptions(orgId),
    loadChannelLimits(orgId),
  ]);
  const agentName = new Map(agentOptions.map((a) => [a.id, a.name]));

  // Quotas (0017): no limit row = unlimited. `blocked` gates the create forms;
  // a kind with limit 0 and no existing channels disappears from the gallery.
  const kindCounts = countChannelsByKind(channels);
  const quota = (kind: ChannelKind): { limit: number | null; count: number; blocked: boolean } => {
    const limit = limits.get(kind) ?? null;
    const count = kindCounts.get(kind) ?? 0;
    return { limit, count, blocked: limit !== null && count >= limit };
  };
  const quotaNotice = (kind: ChannelKind): ReactNode => {
    const q = quota(kind);
    if (!q.blocked) return null;
    return (
      <p className="notice" style={{ marginTop: '0.5rem' }}>
        Kontingent erreicht ({q.count} von {q.limit}). Für weitere Kanäle wende dich an Zendori.
      </p>
    );
  };

  const flavorOf = new Map(channels.map((c: Channel) => [c.id, channelFlavor(c)]));
  const counts = (flavor: string) =>
    channels.filter((c: Channel) => flavorOf.get(c.id) === flavor);

  // strip a trailing slash so the displayed URL matches what the route reconstructs
  const whatsappTwilioWebhookUrl = `${appUrl().replace(/\/+$/, '')}/api/hooks/whatsapp/twilio`;

  const meta = (key: TileKey, name: string, description: string, list: Channel[]): TileMeta => ({
    key,
    name,
    description,
    activeCount: list.filter((c) => c.is_active).length,
    totalCount: list.length,
  });

  // webform shares the 'form' quota kind (product decision 2026-07-21)
  const quotaKindFor = (key: TileKey): ChannelKind =>
    key === 'webform' ? 'form' : (key as ChannelKind);

  const tiles: TileMeta[] = [
    meta('webform', 'Web-Formular', 'Mit dem Zendori-Builder erstellte Formulare zum Einbetten.', counts('webform')),
    meta('form', 'Formular-Weiterleitung', 'Kontaktformulare fremder Systeme per E-Mail-Empfänger anbinden.', counts('form')),
    meta('email', 'E-Mail', 'Bestehende Postfächer per Weiterleitung anbinden.', counts('email')),
    meta('whatsapp', 'WhatsApp', 'WhatsApp-Nummern deines Unternehmens (Twilio).', counts('whatsapp')),
    meta('voice', 'Voice', 'Telefon-Anrufe nimmt der KI-Sprachassistent entgegen.', counts('voice')),
    meta('chat', 'Chat', 'Embeddable Chat-Widget für deine Website.', counts('chat')),
    meta('test', 'Test', 'Nachrichten manuell einspeisen — zum Ausprobieren.', counts('test')),
  ].filter((tile) => !(quota(quotaKindFor(tile.key)).limit === 0 && tile.totalCount === 0));

  // --- create-only panels (per type) -----------------------------------------

  const createPanel = (
    title: string,
    intro: ReactNode,
    kind: ChannelKind,
    form: ReactNode
  ): ReactNode => (
    <div className="panel">
      <h2>{title}</h2>
      <p className="help">{intro}</p>
      {quotaNotice(kind)}
      {quota(kind).blocked ? null : isOwner ? (
        form
      ) : (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Nur Inhaber und Admins können Kanäle anlegen.
        </p>
      )}
    </div>
  );

  const panels: Partial<Record<TileKey, ReactNode>> = {
    form: createPanel(
      'Formular-Weiterleitung anlegen',
      'An diese Adresse gesendete E-Mails (als Empfänger oder in CC) landen automatisch in der Inbox. Ideal für Kontaktformulare beliebiger Websites — kein Code auf der Kundenseite nötig. Der echte Absender wird aus dem Formular-Inhalt extrahiert.',
      'form',
      <form className="stack" action={createIntakeAddress} style={{ maxWidth: '26rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="purpose" value="form" />
        <div>
          <label htmlFor="form-name">Name</label>
          <input id="form-name" name="name" type="text" required minLength={2} maxLength={120} placeholder="z. B. Kontaktformular strong-energy.eu" />
        </div>
        <div>
          <label htmlFor="form-slug">Kürzel (für die Adresse)</label>
          <input id="form-slug" name="slugPart" type="text" required maxLength={40} placeholder="z. B. kf" />
        </div>
        <button className="primary" type="submit">Formular-Adresse anlegen</button>
      </form>
    ),
    email: createPanel(
      'E-Mail-Weiterleitung anlegen',
      'Binde ein bestehendes Postfach an, indem du dort eine Weiterleitung auf die generierte Adresse einrichtest. Weitergeleitete Mails landen in der Inbox; der echte Absender wird aus dem Weiterleitungs-Header übernommen. Eigene Adresse je Postfach = eigener Kanal.',
      'email',
      <form className="stack" action={createIntakeAddress} style={{ maxWidth: '26rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="purpose" value="forwarded_email" />
        <div>
          <label htmlFor="email-name">Name</label>
          <input id="email-name" name="name" type="text" required minLength={2} maxLength={120} placeholder="z. B. Support-Postfach strong-energy.eu" />
        </div>
        <div>
          <label htmlFor="email-slug">Kürzel (für die Adresse)</label>
          <input id="email-slug" name="slugPart" type="text" required maxLength={40} placeholder="z. B. support" />
        </div>
        <button className="primary" type="submit">E-Mail-Adresse anlegen</button>
      </form>
    ),
    whatsapp: createPanel(
      'WhatsApp-Nummer verbinden (Twilio)',
      <>
        Eine Twilio-WhatsApp-Nummer je Kunde. Nachrichten an diese Nummer landen in der Inbox,
        Antworten gehen über Twilio zurück. Nach dem Anlegen diese Webhook-URL in der
        Twilio-Console bei der Nummer unter „A message comes in" (POST) eintragen:{' '}
        <code className="invite-link">{whatsappTwilioWebhookUrl}</code>
      </>,
      'whatsapp',
      <form className="stack" action={createWhatsappTwilioChannel} style={{ maxWidth: '26rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <div>
          <label htmlFor="wa-name">Name</label>
          <input id="wa-name" name="name" type="text" required minLength={2} maxLength={120} placeholder="z. B. WhatsApp Support strong-energy.eu" />
        </div>
        <div>
          <label htmlFor="wa-sender">Absendernummer (+E164)</label>
          <input id="wa-sender" name="sender" type="text" required placeholder="+493012345678" />
        </div>
        <div>
          <label htmlFor="wa-account-sid">Twilio Account SID</label>
          <input id="wa-account-sid" name="accountSid" type="text" required placeholder="AC…" />
        </div>
        <div>
          <label htmlFor="wa-auth-token">Twilio Auth Token</label>
          <input id="wa-auth-token" name="authToken" type="password" required autoComplete="off" placeholder="wird verschlüsselt gespeichert" />
        </div>
        <div>
          <label htmlFor="wa-messaging-service">Messaging Service SID (optional)</label>
          <input id="wa-messaging-service" name="messagingServiceSid" type="text" placeholder="MG… (optional)" />
        </div>
        <button className="primary" type="submit">WhatsApp-Nummer verbinden</button>
      </form>
    ),
    voice: (
      <div className="panel">
        <h2>Telefon (Voice-Agent)</h2>
        <p className="help">
          Anrufe auf der Voice-Nummer nimmt der KI-Sprachassistent entgegen. Die Nummer beantragst
          du unter{' '}
          <Link href={`/settings/phone-numbers?org=${orgId}`}>Einstellungen → Telefonnummern</Link>{' '}
          — nach der Einrichtung erscheint der Kanal oben in der Übersicht; Stimme, Sprache und
          Begrüßung stellst du dann auf seiner Kanal-Seite ein.
        </p>
      </div>
    ),
    chat: createPanel(
      'Chat-Widget anlegen',
      <>
        Das Chat-Widget wird mit einem einzigen Script-Tag in beliebige Websites eingebunden.
        Nachrichten aus dem Widget erscheinen als Konversationen in der Inbox. Ausprobieren:{' '}
        <Link href={`/widget-demo?org=${orgId}`}>Widget-Demo</Link>.
      </>,
      'chat',
      <form className="stack" action={createWidgetChannel} style={{ maxWidth: '26rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <div>
          <label htmlFor="widget-name">Name</label>
          <input id="widget-name" name="name" type="text" required minLength={2} maxLength={80} placeholder="z. B. Website-Chat zendori.de" />
        </div>
        <button className="primary" type="submit">Widget-Channel anlegen</button>
      </form>
    ),
    test: createPanel(
      'Test-Channel anlegen',
      <>
        Ein Test-Channel dient zum manuellen Einspeisen von Nachrichten über den{' '}
        <Link href={`/test-channel?org=${orgId}`}>Test-Channel</Link>. Praktisch, um Inbox, KI und
        Zuweisung ohne echten Kanal auszuprobieren.
      </>,
      'test',
      <form className="stack" action={createTestChannel} style={{ maxWidth: '26rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <div>
          <label htmlFor="test-name">Name</label>
          <input id="test-name" name="name" type="text" required minLength={2} placeholder="z. B. Test-Kanal Support" />
        </div>
        <button className="primary" type="submit">Test-Channel anlegen</button>
      </form>
    ),
    webform: (
      <div className="panel">
        <h2>Web-Formulare</h2>
        <p className="help">
          Mit dem Zendori-Builder gestaltete Formulare (eigenes Design, Einbetten per Script oder
          gehostete Seite). Anlegen und bearbeiten unter{' '}
          <Link href={`/settings/forms?org=${orgId}`}>Formulare</Link>.
        </p>
      </div>
    ),
  };

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Kanäle</h1>
        <p>
          Alle Kanäle von {orgName} in einer Übersicht. Klicke einen Kanal an, um seine
          Einstellungen zu bearbeiten — neue Kanäle legst du unten nach Typ an.
        </p>
      </div>

      <DismissibleBanners error={error} notice={notice} style={{ marginBottom: '1.5rem' }} />

      <div className="panel">
        <h2>Übersicht</h2>
        {channels.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Noch keine Kanäle vorhanden — lege unten den ersten an.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kanal</th>
                <th>Typ</th>
                <th>Adresse / Nummer</th>
                <th>Agent</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel: Channel) => (
                <tr key={channel.id}>
                  <td>
                    <Link
                      href={`/settings/channels/${channel.id}?org=${orgId}`}
                      style={{ fontWeight: 600 }}
                    >
                      {channel.name}
                    </Link>
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {FLAVOR_LABELS[flavorOf.get(channel.id) ?? 'test']}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.85rem', wordBreak: 'break-all' }}>
                    {channelIdentifier(channel)}
                  </td>
                  <td style={{ fontSize: '0.85rem' }}>
                    {channel.agent_id ? (
                      (agentName.get(channel.agent_id) ?? '—')
                    ) : (
                      <span className="badge badge--warn" title="Ohne Agent keine KI-Antworten">
                        kein Agent
                      </span>
                    )}
                  </td>
                  <td>
                    <ActiveToggle orgId={orgId} channelId={channel.id} isActive={channel.is_active} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2 style={{ margin: '1.5rem 0 0.75rem' }}>Neuen Kanal anlegen</h2>
      <ChannelGallery tiles={tiles} panels={panels as Record<TileKey, ReactNode>} />
    </div>
  );
}
