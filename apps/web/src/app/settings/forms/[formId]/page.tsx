import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formDefinitionSchema } from '@zendori/channels';
import { requireActiveOrg } from '@/lib/org';
import { channelFeeOf, formatChannelFee, loadChannelFees } from '@/lib/channel-fees';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { appUrl } from '@/lib/env';
import { href } from '@/lib/href';
import FormBuilder from '@/components/FormBuilder';
import { canViewArea, isAdminRole, type Channel } from '@zendori/core';
import NoAccessPanel from '@/components/NoAccessPanel';
import DismissibleBanners from '@/components/DismissibleBanners';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { SettingRow } from '@/components/ui/Field';
import { Section } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import { ActiveToggle, AgentSelect, listAgentOptions } from '../../channels/shared';
import DeleteFormDrawer from './DeleteFormDrawer';

// The form builder (Phase 10): editor with live preview. The page supplies the
// head; FormBuilder renders the tabs, the two columns and the save bar.
// Deleting (owner-only) sits in the head's menu and opens a drawer
// (?panel=delete) that asks for the form name.
//
// A form is a channel type: this page IS the channel page of a builder form.
// It is reached from the Kanäle list, and the channel's own settings (agent,
// active) sit on the tab "Agent und Status" — their mini-forms post to the
// channel actions and return here (returnTo).

/** Tabs a link or a returning action may open directly (?tab=…). */
const BUILDER_TABS = ['fields', 'design', 'embed', 'forwarding', 'channel'] as const;
type BuilderTab = (typeof BUILDER_TABS)[number];

export default async function FormBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ formId: string }>;
  searchParams: Promise<{
    org?: string;
    error?: string;
    notice?: string;
    panel?: string;
    tab?: string;
  }>;
}) {
  const { formId } = await params;
  const query = await searchParams;
  const { orgId, role, access } = await requireActiveOrg(query.org);
  if (!canViewArea(access, 'channels')) return <NoAccessPanel title="Kanäle" />;
  const supabase = await createSupabaseServerClient();

  const [{ data }, agentOptions] = await Promise.all([
    supabase
      .from('forms')
      .select(
        'id, name, public_token, definition, notification_emails, daily_submission_limit, is_active, channel:channels(id, type, is_active, agent_id)'
      )
      .eq('org_id', orgId)
      .eq('id', formId)
      .maybeSingle(),
    listAgentOptions(orgId),
  ]);
  const form = data as unknown as
    | {
        id: string;
        name: string;
        public_token: string;
        definition: unknown;
        notification_emails: unknown;
        daily_submission_limit: number;
        is_active: boolean;
        channel: Pick<Channel, 'id' | 'type' | 'is_active' | 'agent_id'> | null;
      }
    | null;
  if (!form) notFound();
  const channel = form.channel;
  // The public form answers only while the form AND its channel are active
  // (lib/forms/lookup) — the badge shows exactly that.
  const live = form.is_active && channel?.is_active !== false;

  const definition = formDefinitionSchema.safeParse(form.definition);
  if (!definition.success) notFound();

  const notificationEmails = Array.isArray(form.notification_emails)
    ? form.notification_emails.filter((e): e is string => typeof e === 'string')
    : [];

  const isOwner = isAdminRole(role);
  // a builder form is a channel of kind 'form': what it costs while active (0045)
  const feeEur = channelFeeOf(await loadChannelFees(orgId), 'form');
  const builderPath = `/settings/forms/${form.id}`;
  const builderHref = href(builderPath, { org: orgId });
  const deleting = isOwner && query.panel === 'delete';
  const initialTab: BuilderTab = BUILDER_TABS.find((t) => t === query.tab) ?? 'fields';

  // The channel's own settings, as on every other channel page. Server-rendered
  // here (the mini-forms carry server actions) and handed to the client builder.
  const channelSettings = channel ? (
    <Section title="Agent und Status">
      <div>
        <SettingRow
          label="Agent"
          help="Ohne zugewiesenen Agenten werden Einsendungen nur in der Inbox gesammelt, es gibt keine KI-Antworten."
          htmlFor="form-channel-agent"
        >
          <AgentSelect
            orgId={orgId}
            channelId={channel.id}
            channelType={channel.type}
            agentId={channel.agent_id ?? null}
            agents={agentOptions}
            disabled={!isOwner}
            returnTo={`${builderPath}?tab=channel`}
            selectId="form-channel-agent"
          />
        </SettingRow>
        <SettingRow
          label="Kanal aktiv"
          help={
            feeEur > 0
              ? `Ein inaktives Formular nimmt keine Einsendungen an und kostet nichts. Aktiv kostet es ${formatChannelFee(feeEur)} pro Monat.`
              : 'Ein inaktives Formular nimmt keine Einsendungen an.'
          }
        >
          <ActiveToggle
            orgId={orgId}
            channelId={channel.id}
            isActive={channel.is_active}
            returnTo={`${builderPath}?tab=channel`}
            feeEur={feeEur}
          />
        </SettingRow>
      </div>
    </Section>
  ) : null;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[
          { label: 'Kanäle', href: href('/settings/channels', { org: orgId }) },
          { label: form.name },
        ]}
        title={form.name}
        badges={
          <Badge tone={live ? 'success' : 'muted'} dot>
            {live ? 'Aktiv' : 'Inaktiv'}
          </Badge>
        }
        subtitle="Formular · Gespeicherte Änderungen wirken sofort auf eingebettete Formulare."
        actions={
          <>
            {isOwner ? (
              <Menu>
                <Link
                  className="menu-item menu-item--danger"
                  href={href(`/settings/forms/${form.id}`, { org: orgId, panel: 'delete' })}
                  scroll={false}
                >
                  <span className="menu-label">Formular löschen</span>
                </Link>
              </Menu>
            ) : null}
            <Button href={`/f/${form.public_token}`} icon="external" target="_blank" rel="noopener">
              Ansehen
            </Button>
          </>
        }
      />
      <FormBuilder
        orgId={orgId}
        formId={form.id}
        initialName={form.name}
        initialDefinition={definition.data}
        publicToken={form.public_token}
        notificationEmails={notificationEmails}
        dailyLimit={form.daily_submission_limit}
        isOwner={isOwner}
        embedBase={appUrl().replace(/\/+$/, '')}
        initialTab={initialTab}
        channelSettings={channelSettings}
        banners={
          <DismissibleBanners error={query.error} notice={query.notice} />
        }
      />
      {deleting ? (
        <DeleteFormDrawer
          orgId={orgId}
          formId={form.id}
          formName={form.name}
          closeHref={builderHref}
        />
      ) : null}
    </div>
  );
}
