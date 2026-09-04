import Link from 'next/link';
import type { ConversationStatus } from '@zendori/core';
import { channelBadgeClass } from '@/lib/inbox/channel-badge';
import { formatRelativeTime } from '@/lib/inbox/format';
import type { ConversationListItem, InboxFilters } from '@/lib/inbox/types';

const STATUS_BADGE: Record<string, string> = {
  open: 'badge--info',
  pending: 'badge--warn',
  resolved: 'badge--success',
  hubspot_sent: 'badge--hubspot',
};

const statusLabels: Record<ConversationStatus, string> = {
  open: 'Offen',
  pending: 'Wartend',
  resolved: 'Gelöst',
  hubspot_sent: 'An HubSpot gesendet',
};

type ConversationListProps = {
  items: ConversationListItem[];
  orgId: string;
  filters: InboxFilters;
  selectedId?: string;
};

export default function ConversationList({
  items,
  orgId,
  filters,
  selectedId,
}: ConversationListProps) {
  if (items.length === 0) {
    return (
      <div className="inbox-list">
        <p className="inbox-list-empty">
          {filters.q !== ''
            ? `Keine Treffer für „${filters.q}".`
            : 'Keine Konversationen gefunden.'}
        </p>
      </div>
    );
  }

  return (
    <div className="inbox-list">
      {items.map((item) => {
        const query = new URLSearchParams({
          org: orgId,
          c: item.id,
          status: filters.status,
          channel: filters.channelId,
        });
        if (filters.q !== '') query.set('q', filters.q);
        const displayName = item.contact?.name ?? item.contact?.email ?? 'Unbekannter Kontakt';
        return (
          <Link
            key={item.id}
            href={`/inbox?${query.toString()}`}
            className={item.id === selectedId ? 'inbox-row inbox-row-active' : 'inbox-row'}
          >
            <div className="inbox-row-top">
              <span className="inbox-row-name">{displayName}</span>
              <span className="inbox-row-time">
                {formatRelativeTime(item.last_message_at ?? item.created_at)}
              </span>
            </div>
            {item.subject ? <div className="inbox-row-subject">{item.subject}</div> : null}
            {item.last_message_preview ? (
              <div className="inbox-row-preview">{item.last_message_preview}</div>
            ) : null}
            <div className="inbox-row-meta">
              <span className={`badge ${STATUS_BADGE[item.status] ?? 'badge--muted'}`}>
                {statusLabels[item.status]}
              </span>
              {item.channel ? (
                <span
                  className={channelBadgeClass(item.channel.type)}
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '11rem' }}
                  title={item.channel.name}
                >
                  {item.channel.name}
                </span>
              ) : null}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
