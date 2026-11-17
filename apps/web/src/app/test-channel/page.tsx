// Test-Channel: feed inbound messages by hand, as if they arrived through a
// real channel. Reached from the Kanäle page head (no sidebar entry of its own).
import { requireActiveOrg } from '@/lib/org';
import { listChannels } from '@/lib/inbox/queries';
import { ingestTestMessage } from '@/app/inbox/actions';
import { canEditArea, canViewArea } from '@zendori/core';
import { href } from '@/lib/href';
import NoAccessPanel from '@/components/NoAccessPanel';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { Field } from '@/components/ui/Field';
import { EmptyState, Section } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';

/** id of the form; the submit button sits in the save bar below it. */
const FORM_ID = 'test-message';

export default async function TestChannelPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, access } = await requireActiveOrg(org);
  if (!canEditArea(access, 'inbox')) return <NoAccessPanel title="Test-Channel" />;
  const activeChannels = (await listChannels(orgId)).filter((channel) => channel.is_active);
  const canOpenChannels = canViewArea(access, 'channels');

  return (
    <div className="page">
      {/* the crumb only links back when the member may open Kanäle */}
      <PageHeader
        breadcrumb={[
          canOpenChannels
            ? { label: 'Kanäle', href: href('/settings/channels', { org: orgId }) }
            : { label: 'Kanäle' },
          { label: 'Test-Channel' },
        ]}
        title="Test-Channel"
        subtitle="Speise Nachrichten manuell ein, als kämen sie über einen echten Kanal. Sie erscheinen sofort in der Inbox."
      />

      <div className="page-body">
        {error || notice ? (
          <div className="banners">
            {error ? <Callout tone="danger">{error}</Callout> : null}
            {notice ? <Callout tone="success">{notice}</Callout> : null}
          </div>
        ) : null}

        {activeChannels.length === 0 ? (
          <EmptyState
            title="Kein aktiver Kanal"
            text="Lege zuerst einen Test-Channel an, dann kannst du hier Nachrichten einspeisen."
            action={
              canOpenChannels ? (
                <Button
                  href={href('/settings/channels', { org: orgId, panel: 'new', type: 'test' })}
                  variant="primary"
                >
                  Test-Channel anlegen
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="form-narrow">
            <Section title="Nachricht einspeisen">
              <form id={FORM_ID} className="stack" action={ingestTestMessage}>
                <input type="hidden" name="org" value={orgId} />
                <Field label="Kanal" htmlFor="channelId">
                  <select id="channelId" name="channelId" required>
                    {activeChannels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Kontakt-E-Mail" htmlFor="contactEmail">
                  <input
                    id="contactEmail"
                    name="contactEmail"
                    type="email"
                    required
                    placeholder="kunde@example.com"
                  />
                </Field>
                <Field label="Kontaktname (optional)" htmlFor="contactName">
                  <input id="contactName" name="contactName" type="text" placeholder="Max Mustermann" />
                </Field>
                <Field label="Betreff (optional)" htmlFor="subject">
                  <input id="subject" name="subject" type="text" placeholder="Frage zur Bestellung" />
                </Field>
                <Field label="Nachricht" htmlFor="content">
                  <textarea id="content" name="content" rows={5} required />
                </Field>
                <Field
                  label="Externe ID (optional)"
                  htmlFor="externalId"
                  help="Gleiche ID = Duplikat wird verworfen (Idempotenz-Test)."
                >
                  <input id="externalId" name="externalId" type="text" placeholder="z. B. msg-12345" />
                </Field>
              </form>
            </Section>
          </div>
        )}
      </div>

      {activeChannels.length === 0 ? null : (
        <div className="save-bar">
          <Button type="submit" form={FORM_ID} variant="primary">
            Nachricht einspeisen
          </Button>
        </div>
      )}
    </div>
  );
}
