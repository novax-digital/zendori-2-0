import { z } from 'zod';
import { requireActiveOrg } from '@/lib/org';
import {
  getConversationDetail,
  getHubspotSidebarInfo,
  listCannedResponses,
  listChannels,
  listConversations,
  listMembers,
} from '@/lib/inbox/queries';
import type { InboxFilters } from '@/lib/inbox/types';
import Composer from '@/components/inbox/Composer';
import ContextSidebar from '@/components/inbox/ContextSidebar';
import ConversationList from '@/components/inbox/ConversationList';
import ConversationView from '@/components/inbox/ConversationView';
import FilterBar from '@/components/inbox/FilterBar';
import RealtimeRefresher from '@/components/inbox/RealtimeRefresher';
import SuggestedReply from '@/components/inbox/SuggestedReply';

type InboxSearchParams = {
  org?: string;
  c?: string;
  status?: string;
  channel?: string;
  error?: string;
  notice?: string;
};

function parseFilters(status?: string, channel?: string): InboxFilters {
  const parsedStatus =
    status === 'open' || status === 'pending' || status === 'resolved' ? status : 'all';
  const parsedChannel = channel && z.uuid().safeParse(channel).success ? channel : 'all';
  return { status: parsedStatus, channelId: parsedChannel };
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<InboxSearchParams>;
}) {
  const params = await searchParams;
  const { orgId } = await requireActiveOrg(params.org);
  const filters = parseFilters(params.status, params.channel);
  const selectedId = params.c;

  const [conversations, channels, members, cannedResponses, detail, hubspot] = await Promise.all([
    listConversations(orgId, filters),
    listChannels(orgId),
    listMembers(orgId),
    listCannedResponses(orgId),
    selectedId ? getConversationDetail(orgId, selectedId) : Promise.resolve(null),
    getHubspotSidebarInfo(orgId),
  ]);

  return (
    <div className="inbox-shell">
      <RealtimeRefresher orgId={orgId} />

      {params.error || params.notice ? (
        <div className="inbox-banners">
          {params.error ? <p className="error">{params.error}</p> : null}
          {params.notice ? <p className="notice">{params.notice}</p> : null}
        </div>
      ) : null}

      <div className="inbox-layout">
        <section className="inbox-col" aria-label="Konversationsliste">
          <FilterBar
            orgId={orgId}
            channels={channels}
            filters={filters}
            selectedConversationId={selectedId}
          />
          <ConversationList
            items={conversations}
            orgId={orgId}
            filters={filters}
            selectedId={selectedId}
          />
        </section>

        <section className="inbox-col" aria-label="Konversation">
          {detail ? (
            <>
              <ConversationView detail={detail} />
              {detail.draft ? (
                <SuggestedReply
                  key={detail.draft.id}
                  draft={detail.draft}
                  agent={detail.agent}
                  orgId={orgId}
                  conversationId={detail.conversation.id}
                  mode={detail.conversation.mode}
                  filterStatus={filters.status}
                  filterChannel={filters.channelId}
                />
              ) : null}
              <Composer
                key={detail.conversation.id}
                orgId={orgId}
                conversationId={detail.conversation.id}
                filterStatus={filters.status}
                filterChannel={filters.channelId}
                cannedResponses={cannedResponses}
              />
            </>
          ) : (
            <div className="inbox-placeholder">
              {selectedId ? 'Konversation wurde nicht gefunden.' : 'Wähle eine Konversation aus.'}
            </div>
          )}
        </section>

        <aside className="inbox-col" aria-label="Kontext">
          {detail ? (
            <ContextSidebar
              key={detail.conversation.id}
              orgId={orgId}
              detail={detail}
              members={members}
              hubspot={hubspot}
              filterStatus={filters.status}
              filterChannel={filters.channelId}
            />
          ) : (
            <div className="inbox-placeholder">Keine Konversation ausgewählt.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
