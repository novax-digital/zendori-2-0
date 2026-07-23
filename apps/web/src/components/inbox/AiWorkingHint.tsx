'use client';

import { useEffect, useState } from 'react';

/**
 * Max age before the hint hides itself. Mirrors the server-side render guard in
 * the inbox page: rows can stay 'pending' forever when the worker is down or a
 * deploy skew leaves them behind — the hint must never get stuck permanently.
 */
const MAX_AGE_MS = 3 * 60_000;

/**
 * Lightweight "AI is working" indicator shown between an inbound customer
 * message (processing_state='pending') and the draft/auto-reply appearing.
 * Normal removal happens via the existing RealtimeRefresher (every pipeline
 * exit updates the messages row → postgres_changes → router.refresh()); the
 * local timer is only the belt-and-braces path for a stuck row.
 * Wording is outcome-neutral on purpose: intake-only agents and spam-skips
 * never produce a draft, so we must not promise one.
 */
export default function AiWorkingHint({ createdAt }: { createdAt: string }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const started = Date.parse(createdAt);
    const remaining = Number.isNaN(started) ? 0 : MAX_AGE_MS - (Date.now() - started);
    if (remaining <= 0) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(false), remaining);
    return () => clearTimeout(timer);
  }, [createdAt]);

  if (!visible) return null;

  return (
    <div className="inbox-inline-hint" role="status">
      <span className="ai-working-dot" aria-hidden />
      KI-Agent verarbeitet die Nachricht …
    </div>
  );
}
