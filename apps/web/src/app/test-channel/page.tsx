import Link from 'next/link';
import { requireActiveOrg } from '@/lib/org';
import { listChannels } from '@/lib/inbox/queries';
import { ingestTestMessage } from '@/app/inbox/actions';
import { canEditArea, canViewArea } from '@zendori/core';
import NoAccessPanel from '@/components/NoAccessPanel';
import PageHeader from '@/components/ui/PageHeader';



export default async function TestChannelPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, access } = await requireActiveOrg(org);
  if (!canEditArea(access, 'inbox')) return <NoAccessPanel title="Test-Channel" />;
  const activeChannels = (await listChannels(orgId)).filter((channel) => channel.is_active);

  return (
    <div className="shell">
      {/* reached from the Kanäle page head (no sidebar entry of its own); the
          crumb only links back when the member may open Kanäle */}
      <PageHeader
        breadcrumb={[
          canViewArea(access, 'channels')
            ? { label: 'Kanäle', href: `/settings/channels?org=${orgId}` }
            : { label: 'Kanäle' },
          { label: 'Test-Channel' },
        ]}
        title="Test-Channel"
        subtitle="Speise eingehende Nachrichten manuell ein, als kämen sie über einen echten Kanal — sie erscheinen sofort in der Inbox."
      />


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
        <h2>Nachricht einspeisen</h2>
        {activeChannels.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Kein aktiver Kanal vorhanden — lege zuerst unter{' '}
            <Link href={`/settings/channels?org=${orgId}`}>Einstellungen → Kanäle</Link> einen
            Test-Channel an.
          </p>
        ) : (
          <form className="stack" action={ingestTestMessage} style={{ maxWidth: '32rem' }}>
            <input type="hidden" name="org" value={orgId} />
            <div>
              <label htmlFor="channelId">Kanal</label>
              <select id="channelId" name="channelId" required>
                {activeChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="contactEmail">Kontakt-E-Mail</label>
              <input
                id="contactEmail"
                name="contactEmail"
                type="email"
                required
                placeholder="kunde@example.com"
              />
            </div>
            <div>
              <label htmlFor="contactName">Kontaktname (optional)</label>
              <input id="contactName" name="contactName" type="text" placeholder="Max Mustermann" />
            </div>
            <div>
              <label htmlFor="subject">Betreff (optional)</label>
              <input id="subject" name="subject" type="text" placeholder="Frage zur Bestellung" />
            </div>
            <div>
              <label htmlFor="content">Nachricht</label>
              <textarea id="content" name="content" rows={5} required />
            </div>
            <div>
              <label htmlFor="externalId">Externe ID (optional)</label>
              <input id="externalId" name="externalId" type="text" placeholder="z. B. msg-12345" />
              <p className="hint">Gleiche ID = Duplikat wird verworfen (Idempotenz-Test).</p>
            </div>
            <button className="primary" type="submit">
              Nachricht einspeisen
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
