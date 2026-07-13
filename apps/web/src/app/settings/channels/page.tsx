import Link from 'next/link';
import type { ChannelType } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { listChannels } from '@/lib/inbox/queries';
import { createTestChannel } from '@/app/inbox/actions';

const channelTypeLabels: Record<ChannelType, string> = {
  chat: 'Chat',
  email: 'E-Mail',
  whatsapp: 'WhatsApp',
  voice: 'Telefon',
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
        <h2>Test-Channel anlegen</h2>
        <p
          style={{
            fontSize: '0.9rem',
            color: 'var(--text-muted)',
            marginBottom: '1rem',
          }}
        >
          Ein Test-Channel dient zum manuellen Einspeisen von Nachrichten über den{' '}
          <Link href={`/test-channel?org=${orgId}`}>Test-Channel</Link>. Echte Kanäle (Chat-Widget,
          E-Mail, WhatsApp) folgen in späteren Phasen.
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
