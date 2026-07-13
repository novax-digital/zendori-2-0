import Link from 'next/link';
import type { Channel } from '@zendori/core';
import type { InboxFilters } from '@/lib/inbox/types';

const statusTabs: { value: InboxFilters['status']; label: string }[] = [
  { value: 'all', label: 'Alle' },
  { value: 'open', label: 'Offen' },
  { value: 'pending', label: 'Wartend' },
  { value: 'resolved', label: 'Gelöst' },
];

type FilterBarProps = {
  orgId: string;
  channels: Channel[];
  filters: InboxFilters;
  selectedConversationId?: string;
};

export default function FilterBar({
  orgId,
  channels,
  filters,
  selectedConversationId,
}: FilterBarProps) {
  return (
    <div className="inbox-filterbar">
      <nav className="inbox-tabs" aria-label="Status-Filter">
        {statusTabs.map((tab) => {
          const query = new URLSearchParams({
            org: orgId,
            status: tab.value,
            channel: filters.channelId,
          });
          if (selectedConversationId) query.set('c', selectedConversationId);
          return (
            <Link
              key={tab.value}
              href={`/inbox?${query.toString()}`}
              className={tab.value === filters.status ? 'inbox-tab inbox-tab-active' : 'inbox-tab'}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {/* plain GET form: filtering works without any client-side JS */}
      <form method="get" action="/inbox" className="inbox-filter-form">
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="status" value={filters.status} />
        {selectedConversationId ? (
          <input type="hidden" name="c" value={selectedConversationId} />
        ) : null}
        <select name="channel" defaultValue={filters.channelId} aria-label="Kanal-Filter">
          <option value="all">Alle Kanäle</option>
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </select>
        <button className="ghost" type="submit">
          Filtern
        </button>
      </form>
    </div>
  );
}
