import Link from 'next/link';
import type { Channel } from '@zendori/core';
import type { InboxFilters } from '@/lib/inbox/types';
import Button from '@/components/ui/Button';
import { href } from '@/lib/href';
import ChannelFilter from '@/components/inbox/ChannelFilter';
import SearchField from '@/components/inbox/SearchField';

const statusTabs: { value: InboxFilters['status']; label: string; title?: string }[] = [
  { value: 'all', label: 'Alle' },
  { value: 'open', label: 'Offen' },
  { value: 'pending', label: 'Wartend' },
  { value: 'resolved', label: 'Gelöst' },
];

/** Shown additionally while the org has an active HubSpot integration. */
const HUBSPOT_TAB: { value: InboxFilters['status']; label: string; title?: string } = {
  value: 'hubspot_sent',
  // short label: the tab bar is only as wide as the list column
  label: 'HubSpot',
  title: 'An HubSpot gesendet',
};

type FilterBarProps = {
  orgId: string;
  channels: Channel[];
  filters: InboxFilters;
  selectedConversationId?: string;
  /** Active HubSpot integration ⇒ the 'An HubSpot gesendet' filter appears. */
  showHubspotStatus?: boolean;
};

/**
 * Head of the list column: title + channel filter (56px head), search, then
 * the status tabs. Everything is URL-driven and works without client-side JS.
 */
export default function FilterBar({
  orgId,
  channels,
  filters,
  selectedConversationId,
  showHubspotStatus = false,
}: FilterBarProps) {
  return (
    <>
      {/* plain GET form: filtering + search work without any client-side JS */}
      <form method="get" action="/inbox" className="inbox-filter">
        <input type="hidden" name="org" value={orgId} />
        <input type="hidden" name="status" value={filters.status} />
        {selectedConversationId ? (
          <input type="hidden" name="c" value={selectedConversationId} />
        ) : null}
        <div className="inbox-head inbox-head--plain">
          <h1>Inbox</h1>
          {/* keyed so client-side navigations re-sync the uncontrolled select */}
          <ChannelFilter
            key={filters.channelId}
            options={channels.map((channel) => ({ id: channel.id, name: channel.name }))}
            value={filters.channelId}
          />
        </div>
        <div className="inbox-search">
          {/* keyed so client-side navigations (tab links) re-sync the field */}
          <SearchField key={filters.q} defaultValue={filters.q} />
          <Button type="submit" variant="ghost" iconOnly icon="search" aria-label="Suchen" />
        </div>
      </form>
      <nav className="tabs inbox-status-tabs" aria-label="Status-Filter">
        {(showHubspotStatus ? [...statusTabs, HUBSPOT_TAB] : statusTabs).map((tab) => (
          <Link
            key={tab.value}
            href={href('/inbox', {
              org: orgId,
              status: tab.value,
              channel: filters.channelId,
              q: filters.q,
              c: selectedConversationId,
            })}
            title={tab.title}
            aria-current={tab.value === filters.status ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
