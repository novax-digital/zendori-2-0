// Agent DETAIL page (two-level layout, owner 2026-07-24): the tabbed editor
// (Identität / Verhalten / Kanäle / Wissen) for ONE agent, plus the two-step
// delete zone. All tab contents stay mounted inside the ONE update form
// (EditTabs hides them visually) so every field submits regardless of tab.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { canViewArea, isAdminRole, type Channel } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { listChannels } from '@/lib/inbox/queries';
import AgentBehaviorFields from '@/components/AgentBehaviorFields';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import DismissibleBanners from '@/components/DismissibleBanners';
import EditTabs from '@/components/EditTabs';
import NoAccessPanel from '@/components/NoAccessPanel';
import { deleteAgent, updateAgent } from '../actions';
import {
  MODE_LABELS,
  agentLacksKb,
  channelTypeLabels,
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
  const { data: agentData } = await supabase
    .from('agents')
    .select('id, name, identity, kind, mode, confidence_threshold, is_active, handoff_enabled')
    .eq('org_id', orgId)
    .eq('id', agentId)
    .maybeSingle();
  if (!agentData) notFound();
  const agent = agentData as unknown as AgentRow;

  const [channels, kbs, links] = await Promise.all([
    listChannels(orgId),
    loadKbs(orgId),
    loadKbLinks(orgId),
  ]);
  const linkedKbs = new Set(
    links.filter((l) => l.agent_id === agent.id).map((l) => l.knowledge_base_id)
  );
  const lacksKb = agentLacksKb(agent, kbs.length, linkedKbs.size);

  const identityTab: ReactNode = (
    <div className="stack">
      <div>
        <label htmlFor="agent-name">Name</label>
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
      </div>
      <div>
        <label htmlFor="agent-identity">Identität (System-Prompt)</label>
        <textarea
          id="agent-identity"
          name="identity"
          rows={12}
          maxLength={8000}
          defaultValue={agent.identity ?? ''}
          disabled={disabled}
          placeholder={
            'Wer ist dieser Agent, wie spricht er, was darf er (nicht)?\nz. B. „Du bist Lisa, die freundliche Support-Assistentin von Strong Energy. Du duzt Kunden, hältst dich kurz und verweist bei Vertragsfragen immer an das Team."'
          }
        />
        <p className="hint">Fließt in jede Antwort dieses Agenten ein — Rolle, Tonfall, Regeln.</p>
      </div>
    </div>
  );

  const behaviorTab: ReactNode = (
    <div className="stack">
      <AgentBehaviorFields
        idPrefix="agent"
        kindFixed={agent.kind}
        defaultMode={agent.mode}
        defaultThreshold={agent.confidence_threshold}
        defaultHandoffEnabled={agent.handoff_enabled}
        disabled={disabled}
      />
      <label className="check-row">
        <input type="checkbox" name="isActive" defaultChecked={agent.is_active} disabled={disabled} />
        Agent aktiv (pausiert = verhält sich wie „kein Agent")
      </label>
    </div>
  );

  const eligible = channels.filter((c: Channel) =>
    agent.kind === 'voice' ? c.type === 'voice' : c.type !== 'voice'
  );
  const channelsTab: ReactNode = (
    <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
      <p className="help" style={{ marginBottom: '0.75rem' }}>
        Der Agent bedient die angehakten Kanäle. Ein Kanal kann nur einen Agenten haben — Anhaken
        zieht ihn ggf. von einem anderen Agenten ab. Kanäle ohne Agent bekommen keine KI-Antworten.
        {agent.kind === 'voice'
          ? ' Ein Voice-Agent kann nur Voice-Kanäle bedienen.'
          : ' Ein Text-Agent bedient alle Kanäle außer Telefon.'}
      </p>
      {eligible.length === 0 ? (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          {agent.kind === 'voice'
            ? 'Noch kein Voice-Kanal vorhanden — Nummern beantragst du unter Einstellungen → Telefonnummern.'
            : 'Noch keine passenden Kanäle vorhanden.'}
        </p>
      ) : (
        eligible.map((channel: Channel) => (
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
            {channel.name}
            <span style={{ color: 'var(--text-subtle)', fontSize: '0.8rem' }}>
              ({channelTypeLabels[channel.type]}
              {channel.agent_id && channel.agent_id !== agent.id ? ' · anderer Agent' : ''})
            </span>
          </label>
        ))
      )}
    </fieldset>
  );

  const knowledgeTab: ReactNode = (
    <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
      <p className="help" style={{ marginBottom: '0.75rem' }}>
        Der Agent beantwortet Fragen nur aus den angehakten Datenbanken. Ohne Verknüpfung kennt er
        keine Inhalte und übergibt inhaltliche Fragen an das Team.
      </p>
      {lacksKb ? (
        <p className="notice" style={{ marginBottom: '0.75rem' }}>
          Dieser Agent ist mit keiner Wissensdatenbank verknüpft — er kann inhaltliche Fragen nicht
          beantworten. Hake unten mindestens eine Datenbank an.
        </p>
      ) : null}
      {kbs.length === 0 ? (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Noch keine Wissensdatenbank vorhanden — anlegen unter Einstellungen → Wissensdatenbank.
        </p>
      ) : (
        kbs.map((kb) => {
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
        })
      )}
    </fieldset>
  );

  return (
    <div className="shell">
      <div className="page-head">
        <h1>{agent.name}</h1>
        <p>
          <Link href={`/settings/agents?org=${orgId}`}>← Alle Agenten</Link>
          <span style={{ color: 'var(--text-muted)' }}>
            {' '}· {agent.kind === 'voice' ? 'Voice · ' : ''}
            {MODE_LABELS[agent.mode]} ·{' '}
            {agent.is_active ? 'Aktiv' : 'Pausiert'}
          </span>
        </p>
      </div>

      <DismissibleBanners error={error} notice={notice} style={{ marginBottom: '1.5rem' }} />
      {!isOwner ? (
        <p className="notice" style={{ marginBottom: '1.5rem' }}>
          Nur Inhaber und Admins können Agenten ändern. Die Werte werden schreibgeschützt angezeigt.
        </p>
      ) : null}

      <div className="panel">
        <form className="stack" action={updateAgent} style={{ maxWidth: '40rem' }}>
          <input type="hidden" name="org" value={orgId} />
          <input type="hidden" name="agentId" value={agent.id} />
          <EditTabs
            sections={[
              { key: 'identity', label: 'Identität', content: identityTab },
              { key: 'behavior', label: 'Verhalten', content: behaviorTab },
              { key: 'channels', label: 'Kanäle', content: channelsTab },
              { key: 'knowledge', label: 'Wissen', warn: lacksKb, content: knowledgeTab },
            ]}
          />
          {isOwner ? (
            <button className="primary" type="submit">
              Agent speichern
            </button>
          ) : null}
        </form>
        {isOwner ? (
          <form
            action={deleteAgent}
            style={{ marginTop: '1.75rem', paddingTop: '1.25rem', borderTop: '1px solid var(--border)' }}
          >
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="agentId" value={agent.id} />
            <ConfirmDeleteButton label="Agent löschen" confirmLabel="Endgültig löschen" />
            <p style={{ fontSize: '0.8rem', color: 'var(--text-subtle)', marginTop: '0.4rem' }}>
              Zugewiesene Kanäle laufen danach ohne KI-Antworten weiter.
            </p>
          </form>
        ) : null}
      </div>
    </div>
  );
}
