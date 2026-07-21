import type { ReactNode } from 'react';
import type { AgentKind, AgentMode, Channel, ChannelType } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { listChannels } from '@/lib/inbox/queries';
import AgentGallery, { type AgentTileMeta } from '@/components/AgentGallery';
import AgentBehaviorFields from '@/components/AgentBehaviorFields';
import { createAgent, updateAgent, deleteAgent } from './actions';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';

type AgentRow = {
  id: string;
  name: string;
  identity: string | null;
  kind: AgentKind;
  mode: AgentMode;
  confidence_threshold: number;
  is_active: boolean;
  handoff_enabled: boolean;
};

const MODE_LABELS: Record<AgentMode, string> = {
  draft_only: 'Nur Entwürfe',
  autopilot: 'Autopilot',
  intake_only: 'Reine Annahme',
};

const channelTypeLabels: Record<ChannelType, string> = {
  chat: 'Chat',
  email: 'E-Mail',
  whatsapp: 'WhatsApp',
  voice: 'Telefon',
};




async function supabaseForKbs(orgId: string) {
  const supabase = await createSupabaseServerClient();
  return supabase
    .from('knowledge_bases')
    .select('id, name')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
}

async function supabaseForLinks(orgId: string) {
  const supabase = await createSupabaseServerClient();
  return supabase
    .from('agent_knowledge_bases')
    .select('agent_id, knowledge_base_id')
    .eq('org_id', orgId);
}

async function listAgents(orgId: string): Promise<AgentRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('agents')
    .select('id, name, identity, kind, mode, confidence_threshold, is_active, handoff_enabled')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  return (data ?? []) as unknown as AgentRow[];
}

/** Shared field block for create + edit forms. */
function AgentFields({
  idPrefix,
  agent,
  disabled,
}: {
  idPrefix: string;
  agent?: AgentRow;
  disabled: boolean;
}) {
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-name`}>Name</label>
        <input
          id={`${idPrefix}-name`}
          name="name"
          type="text"
          required
          minLength={2}
          maxLength={80}
          defaultValue={agent?.name ?? ''}
          disabled={disabled}
          placeholder="z. B. Chat-Agent, Telefon-Annahme"
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-identity`}>Identität (System-Prompt)</label>
        <textarea
          id={`${idPrefix}-identity`}
          name="identity"
          rows={7}
          maxLength={8000}
          defaultValue={agent?.identity ?? ''}
          disabled={disabled}
         
          placeholder={
            'Wer ist dieser Agent, wie spricht er, was darf er (nicht)?\nz. B. „Du bist Lisa, die freundliche Support-Assistentin von Strong Energy. Du duzt Kunden, hältst dich kurz und verweist bei Vertragsfragen immer an das Team."'
          }
        />
        <p className="hint">
          Fließt in jede Antwort dieses Agenten ein — Rolle, Tonfall, Regeln.
        </p>
      </div>
      {/* kind/mode/threshold interplay lives in the client component (0015) */}
      <AgentBehaviorFields
        idPrefix={idPrefix}
        kindFixed={agent?.kind}
        defaultMode={agent?.mode}
        defaultThreshold={agent?.confidence_threshold}
        defaultHandoffEnabled={agent?.handoff_enabled}
        disabled={disabled}
      />
    </>
  );
}

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, orgs, role } = await requireActiveOrg(org);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const isOwner = role === 'owner';
  const disabled = !isOwner;

  const [agents, channels] = await Promise.all([listAgents(orgId), listChannels(orgId)]);
  const [{ data: kbData }, { data: linkData }] = await Promise.all([
    supabaseForKbs(orgId),
    supabaseForLinks(orgId),
  ]);
  const kbs = (kbData ?? []) as { id: string; name: string }[];
  const links = (linkData ?? []) as { agent_id: string; knowledge_base_id: string }[];
  const kbsByAgent = new Map<string, Set<string>>();
  for (const link of links) {
    const set = kbsByAgent.get(link.agent_id) ?? new Set<string>();
    set.add(link.knowledge_base_id);
    kbsByAgent.set(link.agent_id, set);
  }
  const channelsByAgent = new Map<string, number>();
  for (const channel of channels) {
    if (channel.agent_id) {
      channelsByAgent.set(channel.agent_id, (channelsByAgent.get(channel.agent_id) ?? 0) + 1);
    }
  }

  const tiles: AgentTileMeta[] = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    modeLabel: `${agent.kind === 'voice' ? 'Voice · ' : ''}${MODE_LABELS[agent.mode]}`,
    isActive: agent.is_active,
    channelCount: channelsByAgent.get(agent.id) ?? 0,
  }));

  const channelChecklist = (agent: AgentRow): ReactNode => {
    // 0015: voice agents serve only voice channels, text agents everything else.
    const eligible = channels.filter((c: Channel) =>
      agent.kind === 'voice' ? c.type === 'voice' : c.type !== 'voice'
    );
    return (
    <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
      <legend style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>
        Zugewiesene Kanäle
      </legend>
      <p className="help" style={{ marginBottom: '0.75rem' }}>
        Der Agent bedient die angehakten Kanäle. Ein Kanal kann nur einen Agenten haben — Anhaken
        zieht ihn ggf. von einem anderen Agenten ab. Kanäle ohne Agent bekommen keine
        KI-Antworten.
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
  };

  const panels: Record<string, ReactNode> = {};
  for (const agent of agents) {
    panels[agent.id] = (
      <div className="panel" key={agent.id}>
        <h2>{agent.name}</h2>
        <form className="stack" action={updateAgent} style={{ maxWidth: '34rem' }}>
          <input type="hidden" name="org" value={orgId} />
          <input type="hidden" name="agentId" value={agent.id} />
          <AgentFields idPrefix={`agent-${agent.id}`} agent={agent} disabled={disabled} />
          <label className="check-row">
            <input
              type="checkbox"
              name="isActive"
              defaultChecked={agent.is_active}
              disabled={disabled}
            />
            Agent aktiv (pausiert = verhält sich wie „kein Agent")
          </label>
          {channelChecklist(agent)}
          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              Wissensdatenbanken
            </legend>
            <p className="help" style={{ marginBottom: '0.75rem' }}>
              Der Agent beantwortet Fragen nur aus den angehakten Datenbanken. Ohne Verknüpfung
              kennt er keine Inhalte und übergibt inhaltliche Fragen an das Team.
            </p>
            {kbs.length === 0 ? (
              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                Noch keine Wissensdatenbank vorhanden — anlegen unter Einstellungen →
                Wissensdatenbank.
              </p>
            ) : (
              kbs.map((kb) => {
                const isLinked = kbsByAgent.get(agent.id)?.has(kb.id) ?? false;
                return (
                  <label key={kb.id} className="check-row">
                    {isLinked ? (
                      <input type="hidden" name="renderedLinkedKbs" value={kb.id} />
                    ) : null}
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
          {isOwner ? (
            <button className="primary" type="submit">
              Agent speichern
            </button>
          ) : null}
        </form>
        {isOwner ? (
          <form
            action={deleteAgent}
            style={{
              marginTop: '1.75rem',
              paddingTop: '1.25rem',
              borderTop: '1px solid var(--border)',
            }}
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
    );
  }

  const newPanel: ReactNode = (
    <div className="panel">
      <h2>Neuen Agenten anlegen</h2>
      <p className="help">
        Ein Agent bündelt Identität (Prompt), Verhalten und Schwellwert. Nach dem Anlegen weist du
        ihm Kanäle zu — so kann der Chat anders auftreten als E-Mail oder Telefon. Neue Agenten
        werden automatisch mit allen Wissensdatenbanken verknüpft (danach anpassbar).
      </p>
      {isOwner ? (
        <form className="stack" action={createAgent} style={{ maxWidth: '34rem' }}>
          <input type="hidden" name="org" value={orgId} />
          <AgentFields idPrefix="new-agent" disabled={false} />
          <button className="primary" type="submit">
            Agent anlegen
          </button>
        </form>
      ) : (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Nur Inhaber können Agenten anlegen.
        </p>
      )}
    </div>
  );

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Agenten</h1>
        <p>
          Die KI-Agenten von {orgName}: jeder Agent hat eine Identität, ein Verhalten und bedient
          die ihm zugewiesenen Kanäle. Übergabe-Regeln und Geschäftszeiten findest du unter
          „Übergabe &amp; Zeiten".
        </p>
      </div>

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
      {!isOwner ? (
        <p className="notice" style={{ marginBottom: '1.5rem' }}>
          Nur Inhaber können Agenten ändern. Die aktuellen Werte werden schreibgeschützt angezeigt.
        </p>
      ) : null}

      <AgentGallery tiles={tiles} panels={panels} newPanel={newPanel} />
    </div>
  );
}
