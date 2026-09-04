'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

/**
 * Subscribes to postgres_changes on messages, conversations and ai_drafts for the
 * active org and refreshes the current route (debounced) so server components
 * re-render with fresh data — this is how a new AI draft appears live above the
 * composer. Renders nothing.
 */
const INBOX_TABLES = ['messages', 'conversations', 'ai_drafts', 'tickets'];

export default function RealtimeRefresher({
  orgId,
  tables = INBOX_TABLES,
  channelKey = 'inbox',
}: {
  orgId: string;
  /** Tables to watch (all must be in the realtime publication and carry org_id). */
  tables?: string[];
  /** Distinct channel name per page family so two refreshers never collide. */
  channelKey?: string;
}): null {
  const router = useRouter();
  const tablesKey = tables.join(',');

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        router.refresh();
      }, 300);
    };

    let channel = supabase.channel(`${channelKey}-${orgId}`);
    for (const table of tablesKey.split(',')) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `org_id=eq.${orgId}` },
        scheduleRefresh
      );
    }
    channel.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [orgId, router, tablesKey, channelKey]);

  return null;
}
