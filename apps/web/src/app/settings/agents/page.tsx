import type { CSSProperties, ReactNode } from 'react';
import type { AgentMode, Channel, ChannelType } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { listChannels } from '@/lib/inbox/queries';
import AgentGallery, { type AgentTileMeta } from '@/components/AgentGallery';
import { createAgent, updateAgent, deleteAgent } from './actions';

type AgentRow = {
  id: string;
  name: string;
  identity: string | null;
  mode: AgentMode;
  confidence_threshold: number;
  is_active: boolean;
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

const helpStyle: CSSProperties = {
  fontSize: '0.9rem',
  color: 'var(--text-muted)',
  marginBottom: '1.25rem',
};

const checkboxRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  fontWeight: 400,
  marginBottom: '0.4rem',
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
    .select('id, name, identity, mode, confidence_threshold, is_active')
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
          style={textareaStyle}
          placeholder={
            'Wer ist dieser Agent, wie spricht er, was darf er (nicht)?\nz. B. „Du bist Lisa, die freundliche Support-Assistentin von Strong Energy. Du duzt Kunden, hältst dich kurz und verweist bei Vertragsfragen immer an das Team."'
          }
        />
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
          Fließt in jede Antwort dieses Agenten ein — Rolle, Tonfall, Regeln.
        </p>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-mode`}>Verhalten</label>
        <select id={`${idPrefix}-mode`} name="mode" defaultValue={agent?.mode ?? 'draft_only'} disabled={disabled}>
          <option value="draft_only">Nur Entwürfe — Vorschläge, ein Mensch prüft und sendet</option>
          <option value="autopilot">Autopilot — antwortet selbst, wenn er sicher genug ist</option>
          <option value="intake_only">Reine Annahme — nimmt das Anliegen auf, antwortet nicht</option>
        </select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-threshold`}>Sicherheits-Schwellwert (0–1, nur Autopilot)</label>
        <input
          id={`${idPrefix}-threshold`}
          name="confidenceThreshold"
          type="number"
          min={0}
          max={1}
          step={0.05}
          defaultValue={agent?.confidence_threshold ?? 0.7}
          disabled={disabled}
        />
      </div>
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
    modeLabel: MODE_LABELS[agent.mode],
    isActive: agent.is_active,
    channelCount: channelsByAgent.get(agent.id) ?? 0,
  }));

  const channelChecklist = (agent: AgentRow): ReactNode => (
    <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
      <legend style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>
        Zugewiesene Kanäle
      </legend>
      <p style={{ ...helpStyle, marginBottom: '0.75rem' }}>
        Der Agent bedient die angehakten Kanäle. Ein Kanal kann nur einen Agenten haben — Anhaken
        zieht ihn ggf. von einem anderen Agenten ab. Kanäle ohne Agent bekommen keine
        KI-Antworten.
      </p>
      {channels.length === 0 ? (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Noch keine Kanäle vorhanden.
        </p>
      ) : (
        channels.map((channel: Channel) => (
          <label key={channel.id} style={checkboxRowStyle}>
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

  const panels: Record<string, ReactNode> = {};
  for (const agent of agents) {
    panels[agent.id] = (
      <div className="panel" key={agent.id}>
        <h2>{agent.name}</h2>
        <form className="stack" action={updateAgent} style={{ maxWidth: '34rem' }}>
          <input type="hidden" name="org" value={orgId} />
          <input type="hidden" name="agentId" value={agent.id} />
          <AgentFields idPrefix={`agent-${agent.id}`} agent={agent} disabled={disabled} />
          <label style={checkboxRowStyle}>
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
            <p style={{ ...helpStyle, marginBottom: '0.75rem' }}>
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
                  <label key={kb.id} style={checkboxRowStyle}>
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
          <form action={deleteAgent} style={{ marginTop: '1rem' }}>
            <input type="hidden" name="org" value={orgId} />
            <input type="hidden" name="agentId" value={agent.id} />
            <button className="ghost" type="submit">
              Agent löschen
            </button>
          </form>
        ) : null}
      </div>
    );
  }

  const newPanel: ReactNode = (
    <div className="panel">
      <h2>Neuen Agenten anlegen</h2>
      <p style={helpStyle}>
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
