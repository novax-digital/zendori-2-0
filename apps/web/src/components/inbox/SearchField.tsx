'use client';

import { useEffect, useRef } from 'react';

/**
 * Search input for the inbox filter form (0028). The native clear button of
 * <input type="search"> only empties the field client-side — WebKit/Blink fire
 * a 'search' event for it, which we use to submit the surrounding GET form so
 * clearing immediately returns to the unfiltered list. Only fires while a
 * search is actually active (defaultValue non-empty); browsers without the
 * clear button (Firefox) reset via Enter on the emptied field as before.
 */
export default function SearchField({ defaultValue }: { defaultValue: string }) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const onSearch = () => {
      if (input.value === '' && defaultValue !== '') input.form?.requestSubmit();
    };
    input.addEventListener('search', onSearch);
    return () => input.removeEventListener('search', onSearch);
  }, [defaultValue]);

  return (
    <input
      ref={ref}
      type="search"
      name="q"
      defaultValue={defaultValue}
      maxLength={200}
      placeholder="Suchen (Betreff, Kontakt, Nachrichten)…"
      aria-label="Inbox durchsuchen"
    />
  );
}
