// Agents OVERVIEW (two-level layout, owner 2026-07-24; redesign stage 4 =
// page type "Liste"): a scannable table — name, mode, channels, knowledge
// warning, status. Clicking a name opens the agent's own page
// (/settings/agents/[agentId]) with the tabbed editor. Creating happens in the
// "Neuer Agent" drawer (?panel=new); deleting sits in the row menu.
import Link from 'next/link';
import { canViewArea, isAdminRole } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { href } from '@/lib/href';
import { listChannels } from '@/lib/inbox/queries';
import DismissibleBanners from '@/components/DismissibleBanners';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import NoAccessPanel from '@/components/NoAccessPanel';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import { createAgent, deleteAgent } from './actions';
import { AgentFields, MODE_LABELS, agentLacksKb, listAgents, loadKbLinks, loadKbs } from './shared';

const LIST = '/settings/agents';

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string; panel?: string }>;
}) {
  const { org, error, notice, panel } = await searchParams;
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

  const listHref = href(LIST, { org: orgId });
  const newHref = href(LIST, { org: orgId, panel: 'new' });
  // only owners/admins may create — the drawer never opens for anyone else
  const drawerOpen = panel === 'new' && isOwner;

  return (
    <div className="page">
      <PageHeader
        title="Agenten"
        subtitle={`Die KI-Agenten von ${orgName}: Jeder bündelt Identität, Verhalten, Kanäle und Wissen.`}
        actions={
          isOwner ? (
            <Button href={newHref} variant="primary" icon="plus" scroll={false}>
              Neuer Agent
            </Button>
          ) : null
        }
      />

      <div className="page-body">
        <div className="page-notices">
          {/* while the drawer is open its own banner shows the error */}
          <DismissibleBanners error={drawerOpen ? undefined : error} notice={notice} />
          {!isOwner ? <Callout>Nur Inhaber und Admins können Agenten ändern.</Callout> : null}
        </div>

        {agents.length === 0 ? (
          <EmptyState
            title="Noch kein Agent"
            text="Ein Agent beantwortet Nachrichten auf den Kanälen, die du ihm zuweist."
            action={
              // secondary: the page head already carries the one primary button
              isOwner ? (
                <Button href={newHref} icon="plus" scroll={false}>
                  Neuer Agent
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Modus</th>
                  <th>Kanäle</th>
                  <th>Wissen</th>
                  <th>Status</th>
                  {isOwner ? <th aria-label="Aktionen" /> : null}
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => {
                  const linked = linkedCount.get(agent.id) ?? 0;
                  const lacksKb = agentLacksKb(agent, kbs.length, linked);
                  const detailHref = href(`${LIST}/${agent.id}`, { org: orgId });
                  return (
                    <tr key={agent.id}>
                      <td>
                        <Link href={detailHref} className="cell-title">
                          {agent.name}
                        </Link>
                        <div className="cell-sub">
                          {agent.kind === 'voice' ? 'Voice-Agent' : 'Text-Agent'}
                        </div>
                      </td>
                      <td>
                        <div className="row">
                          {MODE_LABELS[agent.mode]}
                          {agent.escalation_target === 'ticket' ? (
                            <Badge tone="muted" title="Eskalation als Ticket, kein Mensch live">
                              Ticket-Eskalation
                            </Badge>
                          ) : null}
                        </div>
                      </td>
                      <td>{channelCount.get(agent.id) ?? 0}</td>
                      <td>
                        {lacksKb ? (
                          <Badge tone="warn" title="Keine Wissensdatenbank verknüpft">
                            Fehlt
                          </Badge>
                        ) : (
                          <span className="muted">
                            {agent.mode === 'intake_only' ? '—' : `${linked} verknüpft`}
                          </span>
                        )}
                      </td>
                      <td>
                        {agent.is_active ? (
                          <Badge tone="success" dot>
                            Aktiv
                          </Badge>
                        ) : (
                          <Badge tone="muted" dot>
                            Pausiert
                          </Badge>
                        )}
                      </td>
                      {isOwner ? (
                        <td className="cell-actions">
                          <Menu label={`Aktionen für ${agent.name}`}>
                            <Link className="menu-item" href={detailHref}>
                              <span className="menu-label">Bearbeiten</span>
                            </Link>
                            <form action={deleteAgent}>
                              <input type="hidden" name="org" value={orgId} />
                              <input type="hidden" name="agentId" value={agent.id} />
                              <ConfirmDeleteButton
                                inMenu
                                label="Löschen"
                                confirmLabel="Endgültig löschen"
                              />
                            </form>
                          </Menu>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {drawerOpen ? (
        <Drawer
          title="Neuer Agent"
          closeHref={listHref}
          footer={
            <>
              <Button href={listHref} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="new-agent" variant="primary">
                Agent anlegen
              </Button>
            </>
          }
        >
          <DismissibleBanners error={error} />
          <p className="muted small">
            Nach dem Anlegen weist du dem Agenten Kanäle zu. Er wird automatisch mit allen
            Wissensdatenbanken verknüpft; das lässt sich danach anpassen.
          </p>
          <form id="new-agent" className="stack stack--lg" action={createAgent}>
            <input type="hidden" name="org" value={orgId} />
            <AgentFields idPrefix="new-agent" disabled={false} orgId={orgId} />
          </form>
        </Drawer>
      ) : null}
    </div>
  );
}
