import Link from 'next/link';
import type { ConversationStatus } from '@zendori/core';
import type { ConversationListItem, InboxFilters } from '@/lib/inbox/types';

const statusLabels: Record<ConversationStatus, string> = {
  open: 'Offen',
  pending: 'Wartend',
  resolved: 'Gelöst',
};

/** German relative time without a date library: gerade eben / vor X Min. / vor X Std. / date. */
function formatRelativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  return new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
}

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
        <p className="inbox-list-empty">Keine Konversationen gefunden.</p>
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
              <span className={`inbox-badge inbox-badge-${item.status}`}>
                {statusLabels[item.status]}
              </span>
              {item.channel ? <span className="inbox-row-channel">{item.channel.name}</span> : null}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
