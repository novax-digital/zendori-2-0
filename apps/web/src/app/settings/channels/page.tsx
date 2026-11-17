// Channels LIST (redesign, page type B — docs/design-redesign.md §5/§7): ONE
// table of all channels (name links to /settings/channels/[channelId]) and a
// "Neuer Kanal" drawer. The drawer lives in the URL: ?panel=new&type=<flavor>
// picks the channel type; the page renders the create form of that type on
// the server. All per-channel settings are on the detail page.
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Channel, ChannelKind } from '@zendori/core';
import { canEditArea, canViewArea, isAdminRole } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { listChannels } from '@/lib/inbox/queries';
import { createTestChannel } from '@/app/inbox/actions';
import {
  createWidgetChannel,
  createIntakeAddress,
  createWhatsappTwilioChannel,
} from './actions';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import ChannelIcon from '@/components/ui/ChannelIcon';
import Drawer from '@/components/ui/Drawer';
import { Field, OptionGroup } from '@/components/ui/Field';
import { CodeBlock, EmptyState } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import { appUrl } from '@/lib/env';
import { href } from '@/lib/href';
import { countChannelsByKind, loadChannelLimits } from '@/lib/channel-limits';
import {
  ActiveToggle,
  FLAVOR_LABELS,
  channelFlavor,
  channelIdentifier,
  listAgentOptions,
  type ChannelFlavor,
} from './shared';

const LIST_PATH = '/settings/channels';
/** id of the create form inside the drawer; the footer button submits it. */
const CREATE_FORM_ID = 'new-channel';

/** Channel types in the order the drawer offers them, with their one-line pitch. */
const CREATE_TYPES: { flavor: ChannelFlavor; help: string }[] = [
  { flavor: 'email', help: 'Bestehendes Postfach per Weiterleitung anbinden' },
  { flavor: 'form', help: 'Kontaktformular einer bestehenden Website' },
  { flavor: 'webform', help: 'Im Zendori-Builder gestaltetes Formular' },
  { flavor: 'chat', help: 'Chat für deine Website, ein Script-Tag' },
  { flavor: 'whatsapp', help: 'Nummer über Twilio verbinden' },
  { flavor: 'voice', help: 'Anrufe nimmt der Sprachassistent entgegen' },
  { flavor: 'test', help: 'Nachrichten manuell einspeisen, zum Ausprobieren' },
];

/** Flavors whose identifier is a real address or number worth showing in the list. */
const ROUTED_FLAVORS = new Set<ChannelFlavor>(['form', 'email', 'whatsapp', 'voice']);

/** What the drawer shows for one channel type. */
type CreateView = {
  /** What this channel type does — one or two sentences. */
  intro: ReactNode;
  /** The create form (without its submit button); null = nothing to submit here. */
  form: ReactNode | null;
  /** Label of the primary button in the drawer footer. */
  submitLabel?: string;
};

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{
    org?: string;
    error?: string;
    notice?: string;
    panel?: string;
    type?: string;
  }>;
}) {
  const { org, error, notice, panel, type } = await searchParams;
  const { orgId, role, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'channels')) return <NoAccessPanel title="Kanäle" />;
  const isOwner = isAdminRole(role);

  const [channels, agentOptions, limits] = await Promise.all([
    listChannels(orgId),
    listAgentOptions(orgId),
    loadChannelLimits(orgId),
  ]);
  const agentName = new Map(agentOptions.map((a) => [a.id, a.name]));

  // Quotas (0017): no limit row = unlimited. `blocked` gates the create forms;
  // a kind with limit 0 and no existing channels is not offered at all.
  const kindCounts = countChannelsByKind(channels);
  const quota = (kind: ChannelKind): { limit: number | null; count: number; blocked: boolean } => {
    const limit = limits.get(kind) ?? null;
    const count = kindCounts.get(kind) ?? 0;
    return { limit, count, blocked: limit !== null && count >= limit };
  };
  // webform shares the 'form' quota kind (product decision 2026-07-21)
  const quotaKindFor = (flavor: ChannelFlavor): ChannelKind =>
    flavor === 'webform' ? 'form' : (flavor as ChannelKind);

  const flavorOf = new Map(channels.map((c: Channel) => [c.id, channelFlavor(c)]));
  const countOf = (flavor: ChannelFlavor) =>
    channels.filter((c: Channel) => flavorOf.get(c.id) === flavor).length;

  const listHref = href(LIST_PATH, { org: orgId });
  const newHref = (flavor?: ChannelFlavor) =>
    href(LIST_PATH, { org: orgId, panel: 'new', type: flavor });

  // strip a trailing slash so the displayed URL matches what the route reconstructs
  const whatsappTwilioWebhookUrl = `${appUrl().replace(/\/+$/, '')}/api/hooks/whatsapp/twilio`;

  // --- "Neuer Kanal" drawer ---------------------------------------------------

  const offered = CREATE_TYPES.filter(
    ({ flavor }) => !(quota(quotaKindFor(flavor)).limit === 0 && countOf(flavor) === 0)
  );
  const selected = offered.find(({ flavor }) => flavor === type)?.flavor ?? offered[0]?.flavor;

  /** Hidden fields every create form sends; drawerType brings an error back into the drawer. */
  const formBase = (flavor: ChannelFlavor): ReactNode => (
    <>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="drawerType" value={flavor} />
    </>
  );

  const createView = (flavor: ChannelFlavor): CreateView => {
    switch (flavor) {
      case 'form':
        return {
          intro:
            'An diese Adresse gesendete E-Mails (als Empfänger oder in CC) landen in der Inbox. Der echte Absender wird aus dem Formular-Inhalt gelesen, auf der Website ist kein Code nötig.',
          submitLabel: 'Formular-Adresse anlegen',
          form: (
            <form id={CREATE_FORM_ID} className="stack" action={createIntakeAddress}>
              {formBase('form')}
              <input type="hidden" name="purpose" value="form" />
              <Field label="Name" htmlFor="form-name">
                <input id="form-name" name="name" type="text" required minLength={2} maxLength={120} placeholder="z. B. Kontaktformular strong-energy.eu" />
              </Field>
              <Field label="Kürzel (für die Adresse)" htmlFor="form-slug">
                <input id="form-slug" name="slugPart" type="text" required maxLength={40} placeholder="z. B. kf" />
              </Field>
            </form>
          ),
        };
      case 'email':
        return {
          intro:
            'Richte im bestehenden Postfach eine Weiterleitung auf die neue Adresse ein. Der echte Absender wird aus dem Weiterleitungs-Header übernommen; jedes Postfach bekommt einen eigenen Kanal.',
          submitLabel: 'E-Mail-Adresse anlegen',
          form: (
            <form id={CREATE_FORM_ID} className="stack" action={createIntakeAddress}>
              {formBase('email')}
              <input type="hidden" name="purpose" value="forwarded_email" />
              <Field label="Name" htmlFor="email-name">
                <input id="email-name" name="name" type="text" required minLength={2} maxLength={120} placeholder="z. B. Support-Postfach strong-energy.eu" />
              </Field>
              <Field label="Kürzel (für die Adresse)" htmlFor="email-slug">
                <input id="email-slug" name="slugPart" type="text" required maxLength={40} placeholder="z. B. support" />
              </Field>
            </form>
          ),
        };
      case 'whatsapp':
        return {
          intro:
            'Eine Twilio-WhatsApp-Nummer je Kanal. Nachrichten an die Nummer landen in der Inbox, Antworten gehen über Twilio zurück.',
          submitLabel: 'WhatsApp-Nummer verbinden',
          form: (
            <form id={CREATE_FORM_ID} className="stack" action={createWhatsappTwilioChannel}>
              {formBase('whatsapp')}
              <Field label="Name" htmlFor="wa-name">
                <input id="wa-name" name="name" type="text" required minLength={2} maxLength={120} placeholder="z. B. WhatsApp Support strong-energy.eu" />
              </Field>
              <Field label="Absendernummer (+E164)" htmlFor="wa-sender">
                <input id="wa-sender" name="sender" type="text" required placeholder="+493012345678" />
              </Field>
              <Field label="Twilio Account SID" htmlFor="wa-account-sid">
                <input id="wa-account-sid" name="accountSid" type="text" required placeholder="AC…" />
              </Field>
              <Field label="Twilio Auth Token" htmlFor="wa-auth-token" help="Wird verschlüsselt gespeichert.">
                <input id="wa-auth-token" name="authToken" type="password" required autoComplete="off" />
              </Field>
              <Field label="Messaging Service SID (optional)" htmlFor="wa-messaging-service">
                <input id="wa-messaging-service" name="messagingServiceSid" type="text" placeholder="MG…" />
              </Field>
              <div className="field">
                <span className="field-label">Webhook-URL</span>
                <CodeBlock>{whatsappTwilioWebhookUrl}</CodeBlock>
                <p className="field-help">
                  Nach dem Anlegen in der Twilio-Console bei der Nummer unter „A message comes
                  in“ (POST) eintragen.
                </p>
              </div>
            </form>
          ),
        };
      case 'chat':
        return {
          intro: (
            <>
              Das Widget bindest du mit einem einzigen Script-Tag in deine Website ein. Nachrichten
              erscheinen als Konversationen in der Inbox. Ausprobieren:{' '}
              <Link href={href('/widget-demo', { org: orgId })}>Widget-Demo</Link>
            </>
          ),
          submitLabel: 'Widget-Channel anlegen',
          form: (
            <form id={CREATE_FORM_ID} className="stack" action={createWidgetChannel}>
              {formBase('chat')}
              <Field label="Name" htmlFor="widget-name">
                <input id="widget-name" name="name" type="text" required minLength={2} maxLength={80} placeholder="z. B. Website-Chat zendori.de" />
              </Field>
            </form>
          ),
        };
      case 'test':
        return {
          intro: (
            <>
              Über einen Test-Kanal speist du Nachrichten manuell ein (
              <Link href={href('/test-channel', { org: orgId })}>Test-Channel</Link>), um Inbox, KI
              und Zuweisung ohne echten Kanal auszuprobieren.
            </>
          ),
          submitLabel: 'Test-Channel anlegen',
          form: (
            <form id={CREATE_FORM_ID} className="stack" action={createTestChannel}>
              {formBase('test')}
              <Field label="Name" htmlFor="test-name">
                <input id="test-name" name="name" type="text" required minLength={2} placeholder="z. B. Test-Kanal Support" />
              </Field>
            </form>
          ),
        };
      case 'voice':
        return {
          intro: (
            <>
              Anrufe auf der Nummer nimmt der KI-Sprachassistent entgegen. Die Nummer beantragst du
              unter Telefonnummern. Danach erscheint der Kanal in dieser Liste; Stimme, Sprache und
              Begrüßung stellst du auf seiner Seite ein.
            </>
          ),
          form: null,
        };
      case 'webform':
        return {
          intro:
            'Formulare mit eigenem Design, eingebettet per Script oder als gehostete Seite. Anlegen und bearbeiten kannst du sie unter Formulare.',
          form: null,
        };
    }
  };

  let drawer: ReactNode = null;
  if (panel === 'new') {
    const view = selected ? createView(selected) : null;
    const q = selected ? quota(quotaKindFor(selected)) : null;
    // a form is only shown (and submittable) to owners/admins below the quota
    const canSubmit = Boolean(view?.form) && isOwner && q !== null && !q.blocked;
    drawer = (
      <Drawer
        title="Neuer Kanal"
        closeHref={listHref}
        footer={
          <>
            {q && q.limit !== null ? (
              <span className="drawer-foot-note">
                {q.count} von {q.limit} dieses Typs genutzt
              </span>
            ) : null}
            <Button href={listHref} scroll={false}>
              Abbrechen
            </Button>
            {canSubmit && view?.submitLabel ? (
              <Button type="submit" form={CREATE_FORM_ID} variant="primary">
                {view.submitLabel}
              </Button>
            ) : null}
            {selected === 'voice' ? (
              <Button href={href('/settings/phone-numbers', { org: orgId })} variant="primary">
                Telefonnummern öffnen
              </Button>
            ) : null}
            {selected === 'webform' ? (
              <Button href={href('/settings/forms', { org: orgId })} variant="primary">
                Formulare öffnen
              </Button>
            ) : null}
          </>
        }
      >
        {/* a create error returns into the drawer (createErrorUrl) — show it here,
            not on the dimmed page behind */}
        {error ? <Callout tone="danger">{error}</Callout> : null}
        {selected && view && q ? (
          <>
            <OptionGroup
              label="Kanaltyp"
              value={selected}
              options={offered.map(({ flavor, help }) => ({
                value: flavor,
                title: FLAVOR_LABELS[flavor],
                help,
                href: newHref(flavor),
              }))}
            />
            <p className="muted small">{view.intro}</p>
            {q.blocked ? (
              <Callout tone="warn">
                Kontingent erreicht ({q.count} von {q.limit}). Für weitere Kanäle wende dich an
                Zendori.
              </Callout>
            ) : view.form && !isOwner ? (
              <Callout>Nur Inhaber und Admins können Kanäle anlegen.</Callout>
            ) : (
              view.form
            )}
          </>
        ) : (
          <Callout>Für diese Organisation ist kein Kanaltyp freigeschaltet.</Callout>
        )}
      </Drawer>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Kanäle"
        subtitle="Jeder Kanal liefert Nachrichten in die Inbox."
        actions={
          <>
            {/* former sidebar entry "Test-Channel" (same permission as the page itself) */}
            {canEditArea(access, 'inbox') ? (
              <Button href={href('/test-channel', { org: orgId })}>Testnachricht</Button>
            ) : null}
            <Button href={newHref()} variant="primary" icon="plus" scroll={false}>
              Neuer Kanal
            </Button>
          </>
        }
      />

      <div className="page-body">
        <DismissibleBanners
          // with the drawer open the error is shown inside it
          error={panel === 'new' ? undefined : error}
          notice={notice}
        />

        {channels.length === 0 ? (
          <EmptyState
            title="Noch keine Kanäle"
            text="Lege den ersten Kanal an, damit Nachrichten in der Inbox ankommen."
            action={
              <Button href={newHref()} variant="primary" icon="plus" scroll={false}>
                Neuer Kanal
              </Button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kanal</th>
                  <th>Typ</th>
                  <th>Agent</th>
                  <th>Aktiv</th>
                  <th aria-label="Aktionen" />
                </tr>
              </thead>
              <tbody>
                {channels.map((channel: Channel) => {
                  const flavor = flavorOf.get(channel.id) ?? 'test';
                  const detailHref = href(`${LIST_PATH}/${channel.id}`, { org: orgId });
                  return (
                    <tr key={channel.id}>
                      <td>
                        <div className="cell-main">
                          <ChannelIcon kind={flavor} size="md" />
                          <div className="grow">
                            <Link href={detailHref} className="cell-title">
                              {channel.name}
                            </Link>
                            {/* only real routing identifiers (address, number) */}
                            {ROUTED_FLAVORS.has(flavor) ? (
                              <div className="cell-sub mono">{channelIdentifier(channel)}</div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td>{FLAVOR_LABELS[flavor]}</td>
                      <td>
                        {channel.agent_id ? (
                          (agentName.get(channel.agent_id) ?? '—')
                        ) : (
                          <Badge tone="warn" title="Ohne Agent keine KI-Antworten">
                            Kein Agent
                          </Badge>
                        )}
                      </td>
                      <td>
                        <ActiveToggle
                          orgId={orgId}
                          channelId={channel.id}
                          isActive={channel.is_active}
                        />
                      </td>
                      <td className="cell-actions">
                        <Menu label={`Aktionen für ${channel.name}`}>
                          <Link className="menu-item" href={detailHref}>
                            <span className="menu-label">Einstellungen</span>
                          </Link>
                          {flavor === 'test' && canEditArea(access, 'inbox') ? (
                            <Link className="menu-item" href={href('/test-channel', { org: orgId })}>
                              <span className="menu-label">Testnachricht senden</span>
                            </Link>
                          ) : null}
                          {flavor === 'chat' ? (
                            <Link className="menu-item" href={href('/widget-demo', { org: orgId })}>
                              <span className="menu-label">Widget-Demo öffnen</span>
                            </Link>
                          ) : null}
                        </Menu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {drawer}
    </div>
  );
}
