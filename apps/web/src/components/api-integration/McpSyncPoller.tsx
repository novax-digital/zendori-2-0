'use client';

// Shown while the worker reads an MCP server's tool list (Phase 14a). Polls the
// connection until the request is answered, then refreshes the page — the server
// components then render the new list (or the error) and this component is gone.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Callout from '@/components/ui/Callout';
import { getMcpSyncState } from '@/app/settings/integrations/api/actions';

const POLL_MS = 1_500;
/** After this many polls (~30 s) the worker is probably not picking the request up. */
const SLOW_AFTER_POLLS = 20;
const MAX_POLLS = 120;

export default function McpSyncPoller({
  orgId,
  connectionId,
}: {
  orgId: string;
  connectionId: string;
}) {
  const router = useRouter();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let polls = 0;
    const timer = setInterval(() => {
      void (async () => {
        polls += 1;
        const state = await getMcpSyncState(orgId, connectionId).catch(() => null);
        if (cancelled) return;
        if (state && !state.pending) {
          clearInterval(timer);
          router.refresh();
          return;
        }
        if (polls >= SLOW_AFTER_POLLS) setSlow(true);
        if (polls >= MAX_POLLS) clearInterval(timer);
      })();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [orgId, connectionId, router]);

  return slow ? (
    <Callout tone="warn">
      Die Werkzeugliste wurde noch nicht gelesen. Läuft der Worker in der aktuellen Version? Die
      Anfrage bleibt bestehen — lade die Seite später neu.
    </Callout>
  ) : (
    <Callout>Die Werkzeugliste des Servers wird gelesen …</Callout>
  );
}
