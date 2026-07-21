'use client';

import { useEffect, useRef, useState } from 'react';
import { mountLiveForm } from '@/form-embed/controller';

/**
 * Client mount for the hosted form page: uses the exact same controller +
 * renderer as the embed bundle (single source of truth). The API base is the
 * page's own origin.
 */
export default function HostedForm({ token }: { token: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    void mountLiveForm(host, token, window.location.origin).then((mounted) => {
      if (!cancelled && !mounted) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (failed) {
    return (
      <p style={{ color: '#64748b', fontSize: '0.95rem', textAlign: 'center' }}>
        Dieses Formular ist derzeit nicht verfügbar.
      </p>
    );
  }
  return <div ref={hostRef} />;
}
