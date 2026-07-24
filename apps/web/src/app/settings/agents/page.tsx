// Agents OVERVIEW (two-level layout, owner 2026-07-24): a scannable list —
// name, mode, channels, knowledge warning, status, two-step delete. Clicking a
// name opens the agent's own page (/settings/agents/[agentId]) with the tabbed
// editor. Creating stays here behind a collapsible.
import Link from 'next/link';
import { canViewArea, isAdminRole } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { listChannels } from '@/lib/inbox/queries';
import DismissibleBanners from '@/components/DismissibleBanners';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import NoAccessPanel from '@/components/NoAccessPanel';
import { createAgent, deleteAgent } from './actions';
import { AgentFields, MODE_LABELS, agentLacksKb, listAgents, loadKbLinks, loadKbs } from './shared';

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { org, error, notice } = await searchParams;
  const { orgId, orgs, role, access } = await requireActiveOrg(org);
  if (!canViewArea(access, 'agents')) return <NoAccessPanel title="KI-Agenten" />;
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'Organisation';
  const isOwner = isAdminRole(role);

  const [agents, channels, kbs, links] = await Promise.all([
    listAgents(orgId),
    listChannels(orgId),
    loadKbs(orgId),
    loadKbLinks(orgId),
  ]);

  const linkedCount = new Map<string, number>();
  for (const link of links) {
    linkedCount.set(link.agent_id, (linkedCount.get(link.agent_id) ?? 0) + 1);
  }
  const channelCount = new Map<string, number>();
  for (const channel of channels) {
    if (channel.agent_id) {
      channelCount.set(channel.agent_id, (channelCount.get(channel.agent_id) ?? 0) + 1);
    }
  }

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Agenten</h1>
        <p>
          Die KI-Agenten von {orgName}. Klicke einen Agenten an, um Identität, Verhalten, Kanäle
          und Wissen zu bearbeiten. Übergabe-Regeln und Geschäftszeiten findest du unter
          Einstellungen → „Übergabe &amp; Zeiten".
        </p>
      </div>

      <DismissibleBanners error={error} notice={notice} style={{ marginBottom: '1.5rem' }} />

      <div className="panel">
        <h2>Übersicht</h2>
        {agents.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Noch kein Agent angelegt — lege unten den ersten an.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Modus</th>
                <th>Kanäle</th>
                <th>Wissen</th>
                <th>Status</th>
                {isOwner ? <th></th> : null}
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const lacksKb = agentLacksKb(agent, kbs.length, linkedCount.get(agent.id) ?? 0);
                return (
                  <tr key={agent.id}>
                    <td>
                      <Link
                        href={`/settings/agents/${agent.id}?org=${orgId}`}
                        style={{ fontWeight: 600 }}
                      >
                        {agent.name}
                      </Link>
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>
                      {agent.kind === 'voice' ? 'Voice · ' : ''}
                      {MODE_LABELS[agent.mode]}
                    </td>
                    <td>
                      <span className="badge">{channelCount.get(agent.id) ?? 0}</span>
                    </td>
                    <td>
                      {lacksKb ? (
                        <span className="badge badge--warn" title="Keine Wissensdatenbank verknüpft">
                          ⚠ fehlt
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                          {agent.mode === 'intake_only' ? '—' : `${linkedCount.get(agent.id) ?? 0} verknüpft`}
                        </span>
                      )}
                    </td>
                    <td>
                      {agent.is_active ? (
                        <span className="badge badge--success">Aktiv</span>
                      ) : (
                        <span className="badge">Pausiert</span>
                      )}
                    </td>
                    {isOwner ? (
                      <td style={{ textAlign: 'right' }}>
                        <form action={deleteAgent} style={{ display: 'inline-block' }}>
                          <input type="hidden" name="org" value={orgId} />
                          <input type="hidden" name="agentId" value={agent.id} />
                          <ConfirmDeleteButton label="Löschen" confirmLabel="Endgültig löschen" />
                        </form>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {!isOwner ? (
          <p className="hint" style={{ marginTop: '0.75rem' }}>
            Nur Inhaber und Admins können Agenten ändern.
          </p>
        ) : null}
      </div>

      {isOwner ? (
        <div className="panel">
          <details className="chan-settings">
            <summary>+ Neuen Agenten anlegen</summary>
            <p className="help" style={{ margin: '0.75rem 0' }}>
              Ein Agent bündelt Identität (Prompt), Verhalten und Schwellwert. Nach dem Anlegen
              weist du ihm Kanäle zu — so kann der Chat anders auftreten als E-Mail oder Telefon.
              Neue Agenten werden automatisch mit allen Wissensdatenbanken verknüpft (danach
              anpassbar).
            </p>
            <form className="stack" action={createAgent} style={{ maxWidth: '34rem' }}>
              <input type="hidden" name="org" value={orgId} />
              <AgentFields idPrefix="new-agent" disabled={false} />
              <button className="primary" type="submit">
                Agent anlegen
              </button>
            </form>
          </details>
        </div>
      ) : null}
    </div>
  );
}
