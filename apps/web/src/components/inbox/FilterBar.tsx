import Link from 'next/link';
import type { Channel } from '@zendori/core';
import type { InboxFilters } from '@/lib/inbox/types';

const statusTabs: { value: InboxFilters['status']; label: string }[] = [
  { value: 'all', label: 'Alle' },
  { value: 'open', label: 'Offen' },
  { value: 'pending', label: 'Wartend' },
  { value: 'resolved', label: 'Gelöst' },
];

/** Shown additionally while the org has an active HubSpot integration. */
const HUBSPOT_TAB: { value: InboxFilters['status']; label: string } = {
  value: 'hubspot_sent',
  label: 'An HubSpot gesendet',
};

type FilterBarProps = {
  orgId: string;
  channels: Channel[];
  filters: InboxFilters;
  selectedConversationId?: string;
  /** Active HubSpot integration ⇒ the 'An HubSpot gesendet' filter appears. */
  showHubspotStatus?: boolean;
};

export default function FilterBar({
  orgId,
  channels,
  filters,
  selectedConversationId,
  showHubspotStatus = false,
}: FilterBarProps) {
  return (
    <div className="inbox-filterbar">
      <nav className="inbox-tabs" aria-label="Status-Filter">
        {(showHubspotStatus ? [...statusTabs, HUBSPOT_TAB] : statusTabs).map((tab) => {
          const query = new URLSearchParams({
            org: orgId,
            status: tab.value,
            channel: filters.channelId,
          });
          if (filters.q !== '') query.set('q', filters.q);
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
      {/* plain GET form: filtering + search work without any client-side JS */}
      <form method="get" action="/inbox" className="inbox-filter-form">
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="status" value={filters.status} />
        {selectedConversationId ? (
          <input type="hidden" name="c" value={selectedConversationId} />
        ) : null}
        <input
          type="search"
          name="q"
          defaultValue={filters.q}
          maxLength={200}
          placeholder="Suchen (Betreff, Kontakt, Nachrichten)…"
          aria-label="Inbox durchsuchen"
        />
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
