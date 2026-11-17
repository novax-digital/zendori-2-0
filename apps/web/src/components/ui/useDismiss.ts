'use client';

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

/**
 * Closes a popover on an outside click and on Escape. Attach the returned ref
 * to the element that wraps BOTH the trigger and the popover.
 */
export function useDismiss<T extends HTMLElement>(
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>
) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);
  return ref;
}
