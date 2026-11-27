import Link from 'next/link';
import type { ConversationStatus } from '@zendori/core';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import ChannelIcon from '@/components/ui/ChannelIcon';
import { EmptyState } from '@/components/ui/Layout';
import { href } from '@/lib/href';
import { formatRelativeTime } from '@/lib/inbox/format';
import type { ConversationListItem, InboxFilters } from '@/lib/inbox/types';

// Queue state of a conversation: 'pending' is THE waiting queue (CLAUDE.md §6).
const STATUS_BADGE: Record<ConversationStatus, { label: string; tone: BadgeTone; title?: string }> = {
  open: { label: 'Offen', tone: 'info' },
  pending: { label: 'Wartend', tone: 'warn' },
  resolved: { label: 'Gelöst', tone: 'success' },
  hubspot_sent: { label: 'HubSpot', tone: 'hubspot', title: 'An HubSpot gesendet' },
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
        <EmptyState
          title={filters.q !== '' ? 'Keine Treffer' : 'Keine Konversationen'}
          text={
            filters.q !== ''
              ? `Für „${filters.q}" wurde nichts gefunden.`
              : 'Mit diesen Filtern gibt es keine Konversationen.'
          }
        />
      </div>
    );
  }

  return (
    <div className="inbox-list">
      {items.map((item) => {
        const displayName = item.contact?.name ?? item.contact?.email ?? 'Unbekannter Kontakt';
        const status = STATUS_BADGE[item.status];
        const active = item.status === 'open' || item.status === 'pending';
        return (
          <Link
            key={item.id}
            href={href('/inbox', {
              org: orgId,
              c: item.id,
              status: filters.status,
              channel: filters.channelId,
              q: filters.q,
            })}
            className={item.id === selectedId ? 'inbox-row inbox-row--active' : 'inbox-row'}
            aria-current={item.id === selectedId ? 'true' : undefined}
          >
            {/* the channel TYPE as a mark; the channel's own name follows as plain text */}
            <ChannelIcon kind={item.channel?.type ?? 'test'} />
            <div className="inbox-row-body">
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
                <Badge tone={status.tone} dot={active} title={status.title}>
                  {status.label}
                </Badge>
                {/* who answers while the conversation is live: the bot or a human */}
                {active ? <Badge>{item.mode === 'bot' ? 'Bot' : 'Mensch'}</Badge> : null}
                {/* tried out from the channel's "Test" tab (0050) — not a customer */}
                {item.is_test ? (
                  <Badge tone="accent" title="Testgespräch aus dem Reiter „Test“ des Kanals">
                    Test
                  </Badge>
                ) : null}
                {item.channel ? (
                  <span className="inbox-row-channel" title={item.channel.name}>
                    {item.channel.name}
                  </span>
                ) : null}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
