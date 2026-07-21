import Link from 'next/link';
import Script from 'next/script';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';

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

  return (
    <div className="shell">
      <header>
        <Link href={`/settings/channels?org=${orgId}`}>Zurück zu den Kanälen</Link>
      </header>
      <div className="page-head">
        <h1>Widget-Demo</h1>
        <p>So erscheint das Chat-Widget von {orgName} auf einer Kundenwebsite.</p>
      </div>

      {widget ? (
        <div className="panel">
          <h2>So testest du das Widget</h2>
          <p style={{ fontSize: '0.9rem', marginBottom: '0.75rem' }}>
            Diese Seite bindet das Chat-Widget des Kanals „{widget.name}“ genau so ein, wie es
            später auf einer Kundenwebsite erscheint: als Chat-Bubble unten rechts.
          </p>
          <ol style={{ paddingLeft: '1.25rem', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
            <li>Chat-Bubble unten rechts anklicken und eine Nachricht senden.</li>
            <li>
              Die Nachricht erscheint sofort in der <Link href={`/inbox?org=${orgId}`}>Inbox</Link>{' '}
              als Konversation.
            </li>
            <li>Eine Antwort aus der Inbox erscheint in Echtzeit hier im Widget.</li>
          </ol>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Die Widget-Sitzung ist anonym und wird in diesem Browser gespeichert — genau wie bei
            echten Website-Besuchern. Farbe, Titel und Begrüßung lassen sich in den{' '}
            <Link href={`/settings/channels?org=${orgId}`}>Kanal-Einstellungen</Link> anpassen.
          </p>
        </div>
      ) : (
        <div className="panel">
          <h2>Noch kein Widget-Channel</h2>
          <p style={{ fontSize: '0.9rem', marginBottom: '0.75rem' }}>
            Für diese Organisation existiert noch kein Widget-Channel. Lege zuerst einen an, um das
            Chat-Widget hier auszuprobieren.
          </p>
          <p style={{ fontSize: '0.9rem' }}>
            <Link href={`/settings/channels?org=${orgId}`}>
              Widget-Channel in den Einstellungen anlegen
            </Link>
          </p>
        </div>
      )}

      {widget ? (
        <Script src="/widget.js" data-zendori-token={widget.token} strategy="afterInteractive" />
      ) : null}
    </div>
  );
}
