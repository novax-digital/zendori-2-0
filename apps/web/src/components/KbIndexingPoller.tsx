'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const POLL_INTERVAL_MS = 5_000;
/** Safety valve: stop polling after 10 minutes in case the worker is down. */
const MAX_POLL_MS = 10 * 60_000;

/**
 * Refreshes the current route every few seconds while at least one kb_source
 * is still 'pending', so the status badges flip to "Indiziert"/"Fehler"
 * without a manual reload. kb_sources is not in the realtime publication, so
 * lightweight polling is the correct mechanism here (no migration needed).
 * The `active` prop is recomputed on every server re-render — once no source
 * is pending anymore the interval tears itself down. Renders nothing.
 */
export default function KbIndexingPoller({ active }: { active: boolean }): null {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (Date.now() - startedAt > MAX_POLL_MS) {
        clearInterval(interval);
        return;
      }
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [active, router]);

  return null;
}
