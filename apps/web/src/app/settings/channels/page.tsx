// Channels LIST (redesign, page type B — docs/design-redesign.md §5/§7): ONE
// table of all channels (name links to /settings/channels/[channelId]) and a
// "Neuer Kanal" drawer. The drawer lives in the URL: ?panel=new&type=<flavor>
// picks the channel type; the page renders the create form of that type on
// the server. All per-channel settings are on the detail page.
//
// Forms are a channel type here (no sidebar entry of their own): "Formular"
// in the drawer offers both intake ways of CLAUDE.md §2 — built in Zendori
// (flavor webform) or an existing website form sending to an intake address
// (flavor form). A built form's row links to its builder,
// /settings/forms/[formId], which is that channel's page.
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Channel, ChannelKind } from '@zendori/core';
import { canEditArea, canViewArea, isAdminRole } from '@zendori/core';
import { formDefinitionSchema } from '@zendori/channels';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { listChannels } from '@/lib/inbox/queries';
import { createTestChannel } from '@/app/inbox/actions';
import { createForm } from '@/app/settings/forms/actions';
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
import { channelFeeOf, formatChannelFee, loadChannelFees } from '@/lib/channel-fees';
import { channelKindOf, countChannelsByKind, loadChannelLimits } from '@/lib/channel-limits';
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

/**
 * Channel types in the order the drawer offers them, with their one-line pitch.
 * A type with several flavors ("Formular") asks for the variant in a second
 * step; the URL always carries the flavor (?type=…).
 */
const CREATE_TYPES: { key: string; title: string; help: string; flavors: ChannelFlavor[] }[] = [
  {
    key: 'email',
    title: FLAVOR_LABELS.email,
    help: 'Bestehendes Postfach per Weiterleitung anbinden',
    flavors: ['email'],
  },
  {
    key: 'form',
    title: 'Formular',
    help: 'In Zendori bauen oder ein bestehendes anbinden',
    flavors: ['webform', 'form'],
  },
  {
    key: 'chat',
    title: FLAVOR_LABELS.chat,
    help: 'Chat für deine Website, ein Script-Tag',
    flavors: ['chat'],
  },
  {
    key: 'whatsapp',
    title: FLAVOR_LABELS.whatsapp,
    help: 'Nummer über Twilio verbinden',
    flavors: ['whatsapp'],
  },
  {
    key: 'voice',
    title: FLAVOR_LABELS.voice,
    help: 'Anrufe nimmt der Sprachassistent entgegen',
    flavors: ['voice'],
  },
  {
    key: 'test',
    title: FLAVOR_LABELS.test,
    help: 'Nachrichten manuell einspeisen, zum Ausprobieren',
    flavors: ['test'],
  },
];

/** The two ways a form reaches the inbox, as offered inside the type "Formular". */
const FORM_VARIANTS: Partial<Record<ChannelFlavor, { title: string; help: string }>> = {
  webform: {
    title: 'In Zendori bauen',
    help: 'Felder und Design im Builder, eingebettet per Script oder Link',
  },
  form: {
    title: 'Bestehendes Formular anbinden',
    help: 'Das Formular deiner Website sendet an eine Zendori-Adresse',
  },
};

/** One builder form, as far as the channel list needs it. */
type FormRef = { id: string; channel_id: string; public_token: string; definition: unknown };

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
  const canEdit = canEditArea(access, 'channels');

  const supabase = await createSupabaseServerClient();
  const [channels, agentOptions, limits, fees, { data: formData }] = await Promise.all([
    listChannels(orgId),
    listAgentOptions(orgId),
    loadChannelLimits(orgId),
    // what an ACTIVE channel of each kind costs this customer per month (0045)
    loadChannelFees(orgId),
    // builder forms: their channel row links to the builder (a missing table on
    // a pre-0019 database simply yields no rows)
    supabase.from('forms').select('id, channel_id, public_token, definition').eq('org_id', orgId),
  ]);
  const agentName = new Map(agentOptions.map((a) => [a.id, a.name]));
  const formOf = new Map(((formData ?? []) as FormRef[]).map((f) => [f.channel_id, f]));
  const fieldCount = (definition: unknown): number => {
    const parsed = formDefinitionSchema.safeParse(definition);
    return parsed.success ? parsed.data.fields.length : 0;
  };

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

  // a flavor with limit 0 and no existing channels is not offered at all
  const flavorOffered = (flavor: ChannelFlavor) =>
    !(quota(quotaKindFor(flavor)).limit === 0 && countOf(flavor) === 0);
  const offered = CREATE_TYPES.map((t) => ({ ...t, flavors: t.flavors.filter(flavorOffered) })).filter(
    (t) => t.flavors.length > 0
  );
  const selectedType = offered.find((t) => t.flavors.some((f) => f === type)) ?? offered[0];
  const selected = selectedType?.flavors.find((f) => f === type) ?? selectedType?.flavors[0];

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
            'Ein Formular mit eigenen Feldern und eigenem Design, eingebettet per Script oder als gehostete Seite. Jede Einsendung landet als Konversation in der Inbox.',
          submitLabel: 'Formular anlegen',
          form: (
            <form id={CREATE_FORM_ID} className="stack" action={createForm}>
              {formBase('webform')}
              <Field
                label="Name"
                htmlFor="webform-name"
                help="So heißt das Formular in Zendori und in der Inbox. Felder und Design legst du danach im Builder fest."
              >
                <input id="webform-name" name="name" type="text" required minLength={2} maxLength={120} placeholder="z. B. Kontaktformular Website" />
              </Field>
            </form>
          ),
        };
    }
  };

  let drawer: ReactNode = null;
  if (panel === 'new') {
    const view = selected ? createView(selected) : null;
    const q = selected ? quota(quotaKindFor(selected)) : null;
    const selectedFee = selected ? channelFeeOf(fees, quotaKindFor(selected)) : 0;
    // Channels are created by owners/admins. Builder forms are member-managed
    // content (0019, as on the former Formulare page), so the edit right of the
    // channels area is enough for them.
    const mayCreate = selected === 'webform' ? canEdit : isOwner;
    // a form is only shown (and submittable) to those who may create, below the quota
    const canSubmit = Boolean(view?.form) && mayCreate && q !== null && !q.blocked;
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
          </>
        }
      >
        {/* a create error returns into the drawer (createErrorUrl) — show it here,
            not on the dimmed page behind */}
        {error ? <Callout tone="danger">{error}</Callout> : null}
        {selected && selectedType && view && q ? (
          <>
            <OptionGroup
              label="Kanaltyp"
              value={selectedType.key}
              options={offered.map((t) => ({
                value: t.key,
                title: t.title,
                help: t.help,
                href: newHref(t.flavors[0]),
              }))}
            />
            {/* a type with two ways in ("Formular"): pick the variant */}
            {selectedType.flavors.length > 1 ? (
              <OptionGroup
                label={`Art: ${selectedType.title}`}
                value={selected}
                options={selectedType.flavors.map((flavor) => ({
                  value: flavor,
                  title: FORM_VARIANTS[flavor]?.title ?? FLAVOR_LABELS[flavor],
                  help: FORM_VARIANTS[flavor]?.help,
                  href: newHref(flavor),
                }))}
              />
            ) : null}
            <p className="muted small">{view.intro}</p>
            {selectedFee > 0 && !q.blocked ? (
              <Callout tone="warn" title={`Kostet ${formatChannelFee(selectedFee)} pro Monat`}>
                {selected === 'voice'
                  ? 'Die Gebühr für den Telefonie-Kanal fällt an, sobald deine Rufnummer geschaltet ist, für jeden Monat, in dem der Kanal aktiv ist (netto). Die Rufnummer selbst kommt dazu.'
                  : 'Der Kanal wird als Entwurf angelegt und kostet noch nichts. Die Gebühr fällt erst an, wenn du ihn aktivierst, für jeden Monat, in dem er aktiv ist (netto).'}
              </Callout>
            ) : null}
            {q.blocked ? (
              <Callout tone="warn">
                Kontingent erreicht ({q.count} von {q.limit}). Für weitere Kanäle wende dich an
                Zendori.
              </Callout>
            ) : view.form && !mayCreate ? (
              <Callout>
                {selected === 'webform'
                  ? 'Zum Anlegen von Formularen brauchst du das Bearbeiten-Recht für Kanäle.'
                  : 'Nur Inhaber und Admins können Kanäle anlegen.'}
              </Callout>
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
                  // a built form's channel page is its builder
                  const form = flavor === 'webform' ? formOf.get(channel.id) : undefined;
                  const detailHref = form
                    ? href(`/settings/forms/${form.id}`, { org: orgId })
                    : href(`${LIST_PATH}/${channel.id}`, { org: orgId });
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
                            {form ? (
                              <div className="cell-sub">{fieldCount(form.definition)} Felder</div>
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
                          feeEur={channelFeeOf(fees, channelKindOf(channel))}
                        />
                      </td>
                      <td className="cell-actions">
                        <Menu label={`Aktionen für ${channel.name}`}>
                          <Link className="menu-item" href={detailHref}>
                            <span className="menu-label">
                              {form ? 'Formular bearbeiten' : 'Einstellungen'}
                            </span>
                          </Link>
                          {form ? (
                            <a
                              className="menu-item"
                              href={`/f/${form.public_token}`}
                              target="_blank"
                              rel="noopener"
                            >
                              <span className="menu-label">Formular ansehen</span>
                            </a>
                          ) : null}
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
