'use client';

import { useCallback, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import Callout from './ui/Callout';
import Icon from './ui/Icon';

const NOTICE_TTL_MS = 6_000;
const ERROR_TTL_MS = 12_000;

/**
 * Notice/error banners that live in the URL (?notice=/?error=, written by the
 * server-action redirects). Unlike the previous plain <p> rendering they do not
 * survive forever: each banner auto-clears after a few seconds (notice 6 s,
 * error 12 s) and can be dismissed immediately — router.replace strips only the
 * consumed params and keeps org/c/status/channel intact.
 */
export default function DismissibleBanners({
  error,
  notice,
  className,
  style,
}: {
  error?: string;
  notice?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const router = useRouter();

  const clearParams = useCallback(
    (keys: string[]) => {
      // Read the live URL at dismiss time (client-only code path) so params
      // added since the last server render are preserved.
      const url = new URL(window.location.href);
      let changed = false;
      for (const key of keys) {
        if (url.searchParams.has(key)) {
          url.searchParams.delete(key);
          changed = true;
        }
      }
      if (!changed) return;
      router.replace(`${url.pathname}${url.search}`, { scroll: false });
    },
    [router]
  );

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => clearParams(['notice']), NOTICE_TTL_MS);
    return () => clearTimeout(timer);
  }, [notice, clearParams]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => clearParams(['error']), ERROR_TTL_MS);
    return () => clearTimeout(timer);
  }, [error, clearParams]);

  if (!error && !notice) return null;

  return (
    // `style` stays a prop: pages pass their own bottom margin until they move
    // to the new page types (redesign stages 4-7).
    <div className={`banners${className ? ` ${className}` : ''}`} style={style}>
      {error ? (
        <Callout
          tone="danger"
          action={
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              aria-label="Meldung ausblenden"
              onClick={() => clearParams(['error'])}
            >
              <Icon name="close" size={14} />
            </button>
          }
        >
          {error}
        </Callout>
      ) : null}
      {notice ? (
        <Callout
          tone="success"
          action={
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              aria-label="Hinweis ausblenden"
              onClick={() => clearParams(['notice'])}
            >
              <Icon name="close" size={14} />
            </button>
          }
        >
          {notice}
        </Callout>
      ) : null}
    </div>
  );
}
