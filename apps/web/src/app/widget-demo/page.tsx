import Link from 'next/link';
import Script from 'next/script';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import Button from '@/components/ui/Button';
import { EmptyState, Section } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';

type WidgetChannelRow = {
  id: string;
  name: string;
  config: { public_token?: unknown };
};

export default async function WidgetDemoPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  const { orgId, orgs } = await requireActiveOrg(org);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';

  // user-scoped query — members may read their org's channels via RLS
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('channels')
    .select('id, name, config')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .contains('config', { widget: true })
    .order('created_at', { ascending: true })
    .limit(1);
  const channel = (data ?? [])[0] as WidgetChannelRow | undefined;
  const widget =
    channel && typeof channel.config.public_token === 'string'
      ? { name: channel.name, token: channel.config.public_token }
      : null;

  const channelsHref = `/settings/channels?org=${orgId}`;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: 'Kanäle', href: channelsHref }, { label: 'Widget-Demo' }]}
        title="Widget-Demo"
        subtitle={`So erscheint das Chat-Widget von ${orgName} auf einer Kundenwebsite.`}
      />
      <div className="page-body">
        {widget ? (
          <div className="form-narrow">
            <Section
              title="So testest du das Widget"
              help={`Diese Seite bindet das Chat-Widget des Kanals „${widget.name}“ so ein wie eine Kundenwebsite: als Chat-Bubble unten rechts.`}
            >
              <ol className="steps">
                <li>Chat-Bubble unten rechts anklicken und eine Nachricht senden.</li>
                <li>
                  Die Nachricht erscheint sofort in der{' '}
                  <Link href={`/inbox?org=${orgId}`}>Inbox</Link> als Konversation.
                </li>
                <li>Eine Antwort aus der Inbox erscheint in Echtzeit hier im Widget.</li>
              </ol>
              <p className="field-help">
                Die Widget-Sitzung ist anonym und wird in diesem Browser gespeichert, wie bei
                echten Website-Besuchern. Farbe, Titel und Begrüßung stellst du in den{' '}
                <Link href={channelsHref}>Kanal-Einstellungen</Link> ein.
              </p>
            </Section>
          </div>
        ) : (
          <EmptyState
            title="Noch kein Widget-Channel"
            text="Für diese Organisation gibt es noch keinen Chat-Kanal. Lege zuerst einen an, um das Widget hier auszuprobieren."
            action={
              <Button href={channelsHref} variant="primary">
                Zu den Kanälen
              </Button>
            }
          />
        )}
      </div>

      {widget ? (
        <Script src="/widget.js" data-zendori-token={widget.token} strategy="afterInteractive" />
      ) : null}
    </div>
  );
}
