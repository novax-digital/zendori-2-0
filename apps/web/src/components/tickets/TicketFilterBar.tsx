import Link from 'next/link';
import type { Channel } from '@zendori/core';
import type { TicketFilters, TicketStatusFilter } from '@/lib/tickets/types';
import { PRIORITY_LABELS } from '@/lib/tickets/labels';

// Filter bar of the Tickets list (Phase 11): status tabs as plain links, the
// rest as a GET form — works without JS, like the inbox FilterBar.

const STATUS_TABS: { value: TicketStatusFilter; label: string }[] = [
  { value: 'active', label: 'Aktiv' },
  { value: 'open', label: 'Offen' },
  { value: 'in_progress', label: 'In Bearbeitung' },
  { value: 'waiting', label: 'Wartet' },
  { value: 'resolved', label: 'Erledigt' },
  { value: 'all', label: 'Alle' },
];

function buildHref(orgId: string, filters: TicketFilters, status: TicketStatusFilter): string {
  const params = new URLSearchParams({ org: orgId, status });
  if (filters.priority !== 'all') params.set('priority', filters.priority);
  if (filters.assignee !== 'all') params.set('assignee', filters.assignee);
  if (filters.channelId !== 'all') params.set('channel', filters.channelId);
  if (filters.q) params.set('q', filters.q);
  return `/tickets?${params.toString()}`;
}

export default function TicketFilterBar({
  orgId,
  filters,
  channels,
}: {
  orgId: string;
  filters: TicketFilters;
  channels: Pick<Channel, 'id' | 'name'>[];
}) {
  return (
    <div className="stack" style={{ gap: '0.75rem', marginBottom: '1rem' }}>
      <div className="tabbar">
        {STATUS_TABS.map((tab) => (
          <Link
            key={tab.value}
            href={buildHref(orgId, filters, tab.value)}
            className={`tab${filters.status === tab.value ? ' tab--active' : ''}`}
            style={{ textDecoration: 'none' }}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      <form method="get" action="/tickets" className="inbox-badges-row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="status" value={filters.status} />
        <select name="priority" defaultValue={filters.priority} aria-label="Priorität">
          <option value="all">Alle Prioritäten</option>
          {(Object.keys(PRIORITY_LABELS) as (keyof typeof PRIORITY_LABELS)[]).map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
        <select name="assignee" defaultValue={filters.assignee} aria-label="Zuständig">
          <option value="all">Alle Zuständigen</option>
          <option value="me">Mir zugewiesen</option>
          <option value="none">Niemandem zugewiesen</option>
        </select>
        <select name="channel" defaultValue={filters.channelId} aria-label="Kanal">
          <option value="all">Alle Kanäle</option>
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </select>
        <input
          type="search"
          name="q"
          defaultValue={filters.q}
          placeholder="Suche: Nummer, Betreff, Kontakt …"
          maxLength={200}
          style={{ minWidth: '16rem' }}
        />
        <button type="submit" className="ghost">
          Filtern
        </button>
      </form>
    </div>
  );
}
