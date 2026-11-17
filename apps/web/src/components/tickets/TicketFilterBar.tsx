import type { Channel } from '@zendori/core';
import Button from '@/components/ui/Button';
import type { TabItem } from '@/components/ui/Layout';
import { href } from '@/lib/href';
import { PRIORITY_LABELS } from '@/lib/tickets/labels';
import type { TicketFilters, TicketStatusCounts, TicketStatusFilter } from '@/lib/tickets/types';

// Filters of the Tickets list (Phase 11, redesigned in stage 4): the status is
// a row of page tabs in the page head (plain links), everything else a GET
// form in the toolbar — works without JS, like the inbox FilterBar.

const STATUS_TABS: { value: TicketStatusFilter; label: string }[] = [
  { value: 'active', label: 'Aktiv' },
  { value: 'open', label: 'Offen' },
  { value: 'in_progress', label: 'In Bearbeitung' },
  { value: 'waiting', label: 'Wartet' },
  { value: 'resolved', label: 'Erledigt' },
  { value: 'all', label: 'Alle' },
];

function listHref(orgId: string, filters: TicketFilters, status: TicketStatusFilter): string {
  return href('/tickets', {
    org: orgId,
    status,
    priority: filters.priority !== 'all' && filters.priority,
    assignee: filters.assignee !== 'all' && filters.assignee,
    channel: filters.channelId !== 'all' && filters.channelId,
    q: filters.q,
  });
}

/**
 * Status tabs for <PageHeader tabs>. `counts` is null while a search term is
 * active — then the tabs show no numbers instead of numbers that do not match
 * the list.
 */
export function ticketStatusTabs(
  orgId: string,
  filters: TicketFilters,
  counts: TicketStatusCounts | null
): TabItem[] {
  const countFor = (value: TicketStatusFilter): number | undefined => {
    if (!counts) return undefined;
    if (value === 'all') return counts.open + counts.in_progress + counts.waiting + counts.resolved;
    if (value === 'active') return counts.open + counts.in_progress + counts.waiting;
    return counts[value];
  };
  return STATUS_TABS.map((tab) => ({
    label: tab.label,
    href: listHref(orgId, filters, tab.value),
    count: countFor(tab.value),
    active: filters.status === tab.value,
  }));
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
  const filtered =
    filters.priority !== 'all' ||
    filters.assignee !== 'all' ||
    filters.channelId !== 'all' ||
    filters.q !== '';
  return (
    <form method="get" action="/tickets" className="toolbar">
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="status" value={filters.status} />
      <input
        type="search"
        name="q"
        defaultValue={filters.q}
        placeholder="Nummer, Betreff oder Kontakt"
        aria-label="Tickets durchsuchen"
        maxLength={200}
      />
      <select name="channel" defaultValue={filters.channelId} aria-label="Kanal">
        <option value="all">Alle Kanäle</option>
        {channels.map((channel) => (
          <option key={channel.id} value={channel.id}>
            {channel.name}
          </option>
        ))}
      </select>
      <select name="assignee" defaultValue={filters.assignee} aria-label="Zuständig">
        <option value="all">Alle Zuständigen</option>
        <option value="me">Mir zugewiesen</option>
        <option value="none">Niemandem zugewiesen</option>
      </select>
      <select name="priority" defaultValue={filters.priority} aria-label="Priorität">
        <option value="all">Alle Prioritäten</option>
        {(Object.keys(PRIORITY_LABELS) as (keyof typeof PRIORITY_LABELS)[]).map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABELS[p]}
          </option>
        ))}
      </select>
      <Button type="submit">Filtern</Button>
      {filtered ? (
        <Button href={href('/tickets', { org: orgId, status: filters.status })} variant="ghost">
          Zurücksetzen
        </Button>
      ) : null}
    </form>
  );
}
