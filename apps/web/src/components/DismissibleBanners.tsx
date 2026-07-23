'use client';

import { useCallback, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

const NOTICE_TTL_MS = 6_000;
const ERROR_TTL_MS = 12_000;

const rowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: '0.75rem',
};

const dismissStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'inherit',
  font: 'inherit',
  fontWeight: 700,
  lineHeight: 1,
  padding: '0 0.1rem',
};

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
    <div className={className} style={{ display: 'grid', gap: '0.5rem', ...style }}>
      {error ? (
        <p className="error" style={rowStyle}>
          <span>{error}</span>
          <button
            type="button"
            style={dismissStyle}
            aria-label="Meldung ausblenden"
            onClick={() => clearParams(['error'])}
          >
            ×
          </button>
        </p>
      ) : null}
      {notice ? (
        <p className="notice" style={rowStyle}>
          <span>{notice}</span>
          <button
            type="button"
            style={dismissStyle}
            aria-label="Hinweis ausblenden"
            onClick={() => clearParams(['notice'])}
          >
            ×
          </button>
        </p>
      ) : null}
    </div>
  );
}
