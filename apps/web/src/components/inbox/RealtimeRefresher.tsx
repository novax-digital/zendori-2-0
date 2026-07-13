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
export default function RealtimeRefresher({ orgId }: { orgId: string }): null {
  const router = useRouter();

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

    const channel = supabase
      .channel(`inbox-${orgId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `org_id=eq.${orgId}` },
        scheduleRefresh
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations', filter: `org_id=eq.${orgId}` },
        scheduleRefresh
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ai_drafts', filter: `org_id=eq.${orgId}` },
        scheduleRefresh
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [orgId, router]);

  return null;
}
