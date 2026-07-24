import { z } from 'zod';
import type { HandoffReason } from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  getConversationDetail,
  getHubspotSidebarInfo,
  listCannedResponses,
  listChannels,
  listConversations,
  listMembers,
} from '@/lib/inbox/queries';
import type { InboxFilters } from '@/lib/inbox/types';
import DismissibleBanners from '@/components/DismissibleBanners';
import AiWorkingHint from '@/components/inbox/AiWorkingHint';
import Composer from '@/components/inbox/Composer';
import ContextSidebar from '@/components/inbox/ContextSidebar';
import ConversationList from '@/components/inbox/ConversationList';
import ConversationView from '@/components/inbox/ConversationView';
import FilterBar from '@/components/inbox/FilterBar';
import RealtimeRefresher from '@/components/inbox/RealtimeRefresher';
import SuggestedReply from '@/components/inbox/SuggestedReply';
import { allowedChannelIds, canViewArea } from '@zendori/core';
import NoAccessPanel from '@/components/NoAccessPanel';

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

/** Neutral fallback when no (non-suppressed) handoff event exists for the conversation. */
const HANDOFF_HINT_FALLBACK = 'Bot pausiert — Konversation liegt beim Team.';

// German hint per §6 handoff reason. 'intake' fires for "Reine Annahme" agents;
// 'manual' is refined to "von Ihnen" when triggered_by matches the viewer.
const HANDOFF_HINTS: Record<HandoffReason, string> = {
  low_confidence: 'Vom Bot übergeben — geringe Sicherheit der KI-Antwort.',
  user_request: 'Vom Bot übergeben — Kunde wünscht einen Menschen.',
  keyword: 'Vom Bot übergeben — Eskalations-Begriff erkannt.',
  manual: 'Bot pausiert — von einem Mitarbeiter übernommen.',
  intake: 'Anliegen aufgenommen — an das Team übergeben (reine Annahme).',
};

/**
 * Resolves why a mode='human' conversation was handed off, from the newest
 * handoff_events row. Suppressed events (0018) never flipped the mode, so they
 * must not masquerade as the cause; pre-0018 rows have outcome NULL and count.
 */
async function resolveHandoffHint(orgId: string, conversationId: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('handoff_events')
    .select('reason, triggered_by')
    .eq('org_id', orgId)
    .eq('conversation_id', conversationId)
    .or('outcome.is.null,outcome.neq.suppressed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return HANDOFF_HINT_FALLBACK;

  const row = data as { reason: string; triggered_by: string | null };
  if (row.reason === 'manual' && row.triggered_by) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user?.id === row.triggered_by) return 'Bot pausiert — von Ihnen übernommen.';
  }
  // defensive lookup: the reason column could grow values this UI predates
  const hint = (HANDOFF_HINTS as Record<string, string | undefined>)[row.reason];
  return hint ?? HANDOFF_HINT_FALLBACK;
}

/**
 * Render guard for the "AI is working" hint: only for fresh rows, so a message
 * stuck in processing_state='pending' (worker down, deploy skew) cannot pin the
 * hint forever. Must stay in sync with MAX_AGE_MS in AiWorkingHint.
 */
const AI_WORKING_MAX_AGE_MS = 3 * 60_000;

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<InboxSearchParams>;
}) {
  const params = await searchParams;
  const { orgId, access } = await requireActiveOrg(params.org);
  if (!canViewArea(access, 'inbox')) return <NoAccessPanel title="Inbox" />;
  const scopedChannelIds = allowedChannelIds(access);
  const filters = parseFilters(params.status, params.channel);
  const selectedId = params.c;

  const [conversations, channels, members, cannedResponses, detail, hubspot] = await Promise.all([
    listConversations(orgId, filters, scopedChannelIds),
    listChannels(orgId, scopedChannelIds),
    listMembers(orgId),
    listCannedResponses(orgId),
    selectedId ? getConversationDetail(orgId, selectedId, scopedChannelIds) : Promise.resolve(null),
    getHubspotSidebarInfo(orgId),
  ]);

  // Why the bot stopped answering (C29) — only loaded for handed-off conversations.
  const handoffHint =
    detail && detail.conversation.mode === 'human'
      ? await resolveHandoffHint(orgId, detail.conversation.id)
      : null;

  // "AI is working" (C30): newest message is an unprocessed customer message on
  // a bot-mode conversation whose channel has an active agent, and no draft yet.
  const newestMessage =
    detail && detail.messages.length > 0 ? detail.messages[detail.messages.length - 1] : null;
  const aiWorking = Boolean(
    detail &&
      !detail.draft &&
      detail.conversation.mode === 'bot' &&
      detail.agent?.is_active === true &&
      newestMessage &&
      newestMessage.direction === 'in' &&
      newestMessage.sender_type === 'contact' &&
      newestMessage.processing_state === 'pending' &&
      Date.now() - Date.parse(newestMessage.created_at) < AI_WORKING_MAX_AGE_MS
  );

  return (
    <div className="inbox-shell">
      <RealtimeRefresher orgId={orgId} />

      <DismissibleBanners error={params.error} notice={params.notice} className="inbox-banners" />

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
                  pausedHint={handoffHint}
                  filterStatus={filters.status}
                  filterChannel={filters.channelId}
                />
              ) : handoffHint ? (
                // handed off without a draft (e.g. reason='intake'): show the
                // reason at conversation level instead of nothing
                <div className="inbox-inline-hint">{handoffHint}</div>
              ) : aiWorking && newestMessage ? (
                <AiWorkingHint key={newestMessage.id} createdAt={newestMessage.created_at} />
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
