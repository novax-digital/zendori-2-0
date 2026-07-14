import Link from 'next/link';
import type { CSSProperties } from 'react';
import { requireActiveOrg } from '@/lib/org';
import { listChannels } from '@/lib/inbox/queries';
import { ingestTestMessage } from '@/app/inbox/actions';

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

const helpTextStyle: CSSProperties = {
  fontSize: '0.8rem',
  color: 'var(--text-muted)',
  marginTop: '0.25rem',
};

export default async function TestChannelPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId } = await requireActiveOrg(org);
  const activeChannels = (await listChannels(orgId)).filter((channel) => channel.is_active);

  return (
    <div className="shell">

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
        <h2>Test-Channel — Nachricht einspeisen</h2>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
          Speist eine eingehende Nachricht manuell ein, als käme sie über einen echten Kanal. Die
          Nachricht erscheint sofort in der <Link href={`/inbox?org=${orgId}`}>Inbox</Link>.
        </p>

        {activeChannels.length === 0 ? (
          <p className="notice">
            Kein aktiver Kanal vorhanden. Lege zuerst unter{' '}
            <Link href={`/settings/channels?org=${orgId}`}>Einstellungen → Kanäle</Link> einen
            Test-Channel an.
          </p>
        ) : (
          <form className="stack" action={ingestTestMessage} style={{ maxWidth: '32rem' }}>
            <input type="hidden" name="org" value={orgId} />
            <div>
              <label htmlFor="channelId">Kanal</label>
              <select id="channelId" name="channelId" required style={{ width: '100%' }}>
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
              <textarea id="content" name="content" rows={5} required style={textareaStyle} />
            </div>
            <div>
              <label htmlFor="externalId">Externe ID (optional)</label>
              <input id="externalId" name="externalId" type="text" placeholder="z. B. msg-12345" />
              <p style={helpTextStyle}>Gleiche ID = Duplikat wird verworfen (Idempotenz-Test).</p>
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
