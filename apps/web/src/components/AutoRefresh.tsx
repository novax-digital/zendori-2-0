'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Re-renders the server page every few seconds while something is running (demo calls, number provisioning). */
export default function AutoRefresh({ active, intervalMs = 3_000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}
