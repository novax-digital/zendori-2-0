// Agent DETAIL page (two-level layout, owner 2026-07-24; redesign stage 5 =
// page type "Detail mit Tabs"): the tabbed editor (Identität / Verhalten /
// Kanäle / Wissen) for ONE agent. All tab contents stay mounted inside the ONE
// update form (EditTabs hides them) so every field submits regardless of tab.
// The delete form lives in the page head's menu — outside the update form,
// because forms must not be nested.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { canViewArea, isAdminRole, sanitizeIntakeFields, type Channel } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { href } from '@/lib/href';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { listChannels } from '@/lib/inbox/queries';
import AgentBehaviorFields from '@/components/AgentBehaviorFields';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import DismissibleBanners from '@/components/DismissibleBanners';
import EditTabs from '@/components/EditTabs';
import NoAccessPanel from '@/components/NoAccessPanel';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import ChannelIcon from '@/components/ui/ChannelIcon';
import { Field, SettingRow } from '@/components/ui/Field';
import { Section } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import { deleteAgent, updateAgent } from '../actions';
import {
  IDENTITY_HELP,
  IDENTITY_PLACEHOLDER,
  MODE_LABELS,
  agentLacksKb,
  channelTypeLabels,
  loadActionLinks,
  loadDataActions,
  loadKbLinks,
  loadKbs,
  type AgentRow,
} from '../shared';

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>;
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { agentId } = await params;
  const { org, error, notice } = await searchParams;
  const { orgId, role, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'agents')) return <NoAccessPanel title="KI-Agenten" />;
  const isOwner = isAdminRole(role);
  const disabled = !isOwner;

  const supabase = await createSupabaseServerClient();
  let agentRes = await supabase
    .from('agents')
    .select(
      'id, name, identity, kind, mode, confidence_threshold, is_active, handoff_enabled, intake_fields, escalation_target'
    )
    .eq('org_id', orgId)
    .eq('id', agentId)
    .maybeSingle();
  if (agentRes.error && (agentRes.error as { code?: string }).code === '42703') {
    // agents.intake_fields not migrated yet (web ahead of 0027) — retry without.
    agentRes = (await supabase
      .from('agents')
      .select('id, name, identity, kind, mode, confidence_threshold, is_active, handoff_enabled')
      .eq('org_id', orgId)
      .eq('id', agentId)
      .maybeSingle()) as typeof agentRes;
  }
  if (!agentRes.data) notFound();
  const raw = agentRes.data as unknown as Omit<AgentRow, 'intake_fields'> & {
    intake_fields?: unknown;
  };
  const agent: AgentRow = { ...raw, intake_fields: sanitizeIntakeFields(raw.intake_fields) };

  const [channels, kbs, links, dataActions, actionLinks] = await Promise.all([
    listChannels(orgId),
    loadKbs(orgId),
    loadKbLinks(orgId),
    loadDataActions(orgId),
    loadActionLinks(orgId),
  ]);
  const linkedActions = new Set(
    actionLinks.filter((l) => l.agent_id === agent.id).map((l) => l.data_action_id)
  );
  const linkedKbs = new Set(
    links.filter((l) => l.agent_id === agent.id).map((l) => l.knowledge_base_id)
  );
  const lacksKb = agentLacksKb(agent, kbs.length, linkedKbs.size);

  const identityTab: ReactNode = (
    <div className="stack">
      <Field label="Name" htmlFor="agent-name">
        <input
          id="agent-name"
          name="name"
          type="text"
          required
          minLength={2}
          maxLength={80}
          defaultValue={agent.name}
          disabled={disabled}
        />
      </Field>
      <Field label="Identität (System-Prompt)" htmlFor="agent-identity" help={IDENTITY_HELP}>
        <textarea
          id="agent-identity"
          name="identity"
          rows={12}
          maxLength={8000}
          defaultValue={agent.identity ?? ''}
          disabled={disabled}
          placeholder={IDENTITY_PLACEHOLDER}
        />
      </Field>
    </div>
  );

  const behaviorTab: ReactNode = (
    <>
      <AgentBehaviorFields
        idPrefix="agent"
        kindFixed={agent.kind}
        defaultMode={agent.mode}
        defaultThreshold={agent.confidence_threshold}
        defaultHandoffEnabled={agent.handoff_enabled}
        defaultEscalationTarget={agent.escalation_target === 'ticket' ? 'ticket' : 'human'}
        defaultIntakeFields={agent.intake_fields}
        handoffSettingsHref={href('/settings/ai', { org: orgId })}
        disabled={disabled}
      />
      <Section title="Status">
        <SettingRow
          label="Agent aktiv"
          htmlFor="agent-active"
          help="Pausiert verhält er sich wie „kein Agent“: Seine Kanäle bekommen keine KI-Antworten."
        >
          <input
            id="agent-active"
            type="checkbox"
            className="switch"
            name="isActive"
            defaultChecked={agent.is_active}
            disabled={disabled}
          />
        </SettingRow>
      </Section>
    </>
  );

  const eligible = channels.filter((c: Channel) =>
    agent.kind === 'voice' ? c.type === 'voice' : c.type !== 'voice'
  );
  const assignedCount = eligible.filter((c: Channel) => c.agent_id === agent.id).length;
  const channelsTab: ReactNode = (
    <Section
      title="Kanäle"
      help={`Der Agent bedient die angehakten Kanäle. Ein Kanal hat nur einen Agenten: Anhaken zieht ihn von einem anderen Agenten ab. ${
        agent.kind === 'voice'
          ? 'Ein Voice-Agent bedient nur Telefon-Kanäle.'
          : 'Ein Text-Agent bedient alle Kanäle außer Telefon.'
      }`}
    >
      {eligible.length === 0 ? (
        <p className="muted small">
          {agent.kind === 'voice' ? (
            <>
              Noch kein Telefon-Kanal vorhanden.{' '}
              <Link href={href('/settings/phone-numbers', { org: orgId })}>
                Telefonnummer beantragen
              </Link>
            </>
          ) : (
            <>
              Noch keine passenden Kanäle vorhanden.{' '}
              <Link href={href('/settings/channels', { org: orgId })}>Kanäle öffnen</Link>
            </>
          )}
        </p>
      ) : (
        <fieldset className="fieldset-plain">
          <legend className="sr-only">Kanäle dieses Agenten</legend>
          {eligible.map((channel: Channel) => (
            <label key={channel.id} className="check-row">
              {/* render-time truth: only these may be detached by an uncheck */}
              {channel.agent_id === agent.id ? (
                <input type="hidden" name="renderedAssigned" value={channel.id} />
              ) : null}
              <input
                type="checkbox"
                name="channels"
                value={channel.id}
                defaultChecked={channel.agent_id === agent.id}
                disabled={disabled}
              />
              <ChannelIcon kind={channel.type} />
              {channel.name}
              <span className="muted small">
                {channelTypeLabels[channel.type]}
                {channel.agent_id && channel.agent_id !== agent.id ? ' · anderer Agent' : ''}
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </Section>
  );

  const knowledgeTab: ReactNode = (
    <Section
      title="Wissen"
      help="Der Agent beantwortet Fragen nur aus den angehakten Datenbanken. Ohne Verknüpfung kennt er keine Inhalte und übergibt inhaltliche Fragen an das Team."
    >
      {lacksKb ? (
        <Callout tone="warn" title="Keine Wissensdatenbank verknüpft">
          Dieser Agent kann inhaltliche Fragen nicht beantworten. Hake mindestens eine Datenbank an.
        </Callout>
      ) : null}
      {kbs.length === 0 ? (
        <p className="muted small">
          Noch keine Wissensdatenbank vorhanden.{' '}
          <Link href={href('/settings/knowledge', { org: orgId })}>Wissensdatenbank anlegen</Link>
        </p>
      ) : (
        <fieldset className="fieldset-plain">
          <legend className="sr-only">Wissensdatenbanken dieses Agenten</legend>
          {kbs.map((kb) => {
            const isLinked = linkedKbs.has(kb.id);
            return (
              <label key={kb.id} className="check-row">
                {isLinked ? <input type="hidden" name="renderedLinkedKbs" value={kb.id} /> : null}
                <input
                  type="checkbox"
                  name="kbs"
                  value={kb.id}
                  defaultChecked={isLinked}
                  disabled={disabled}
                />
                {kb.name}
              </label>
            );
          })}
        </fieldset>
      )}
    </Section>
  );

  const actionsTab: ReactNode = (
    <Section
      title="Aktionen"
      help="Der Agent darf die angehakten Aktionen in eigenen Systemen aufrufen, zum Beispiel einen Bestellstatus abfragen. Schreibende Aktionen führt nur ein Autopilot-Agent selbst aus — und nur, wenn die Aktion keine Bestätigung verlangt."
    >
      {agent.mode === 'intake_only' ? (
        <Callout>
          Im Modus „Reine Annahme“ nutzt der Agent keine Aktionen. Die Auswahl wird wirksam, sobald
          der Modus wechselt.
        </Callout>
      ) : null}
      {dataActions.length === 0 ? (
        <p className="muted small">
          Noch keine Aktion vorhanden.{' '}
          {isOwner ? (
            <Link href={href('/settings/integrations', { org: orgId })}>
              Eigenes System unter Integrationen verbinden
            </Link>
          ) : (
            'Inhaber und Admins legen Aktionen unter Integrationen an.'
          )}
        </p>
      ) : (
        <fieldset className="fieldset-plain">
          <legend className="sr-only">Aktionen dieses Agenten</legend>
          {dataActions.map((action) => {
            const isLinked = linkedActions.has(action.id);
            return (
              <label key={action.id} className="check-row">
                {isLinked ? (
                  <input type="hidden" name="renderedLinkedActions" value={action.id} />
                ) : null}
                <input
                  type="checkbox"
                  name="actions"
                  value={action.id}
                  defaultChecked={isLinked}
                  disabled={disabled}
                />
                {action.label}
                <span className="muted small">
                  {action.kind === 'write'
                    ? action.requires_confirmation
                      ? 'schreibt · mit Bestätigung'
                      : 'schreibt'
                    : 'liest'}
                  {action.is_active ? '' : ' · pausiert'}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
    </Section>
  );

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[
          { label: 'Agenten', href: href('/settings/agents', { org: orgId }) },
          { label: agent.name },
        ]}
        title={agent.name}
        badges={
          <>
            {agent.is_active ? (
              <Badge tone="success" dot>
                Aktiv
              </Badge>
            ) : (
              <Badge tone="muted" dot>
                Pausiert
              </Badge>
            )}
            <Badge>{agent.kind === 'voice' ? 'Voice' : 'Text'}</Badge>
            <Badge>{MODE_LABELS[agent.mode]}</Badge>
            {agent.escalation_target === 'ticket' ? (
              <Badge tone="muted" title="Eskalation als Ticket, kein Mensch live">
                Ticket-Eskalation
              </Badge>
            ) : null}
          </>
        }
        actions={
          isOwner ? (
            <Menu label="Weitere Aktionen">
              <form action={deleteAgent}>
                <input type="hidden" name="org" value={orgId} />
                <input type="hidden" name="agentId" value={agent.id} />
                <ConfirmDeleteButton inMenu label="Agent löschen" confirmLabel="Endgültig löschen" />
              </form>
              <p className="menu-note">Zugewiesene Kanäle laufen danach ohne KI-Antworten weiter.</p>
            </Menu>
          ) : null
        }
      />

      <form className="page-form page-form--tabs" action={updateAgent}>
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="agentId" value={agent.id} />
        <EditTabs
          label="Bereiche des Agenten"
          before={
            <>
              <DismissibleBanners error={error} notice={notice} />
              {!isOwner ? (
                <Callout>
                  Nur Inhaber und Admins können Agenten ändern. Die Werte werden schreibgeschützt
                  angezeigt.
                </Callout>
              ) : null}
            </>
          }
          sections={[
            { key: 'identity', label: 'Identität', content: identityTab },
            { key: 'behavior', label: 'Verhalten', content: behaviorTab },
            { key: 'channels', label: 'Kanäle', count: assignedCount, content: channelsTab },
            {
              key: 'knowledge',
              label: 'Wissen',
              count: linkedKbs.size,
              warn: lacksKb,
              warnLabel: 'Keine Wissensdatenbank verknüpft',
              content: knowledgeTab,
            },
            { key: 'actions', label: 'Aktionen', count: linkedActions.size, content: actionsTab },
          ]}
        />
        {isOwner ? (
          <div className="save-bar">
            <Button type="submit" variant="primary">
              Agent speichern
            </Button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
