'use client';

import { useEffect, useState } from 'react';

// Auto / Light / Dark segmented control. Persists the preference; the no-flash
// head script (layout.tsx) applies the initial data-theme before paint. In
// 'auto' we mirror the OS and update live when it changes.

type Pref = 'auto' | 'light' | 'dark';

const STORAGE_KEY = 'zendori-theme';

function resolve(pref: Pref): 'light' | 'dark' {
  if (pref === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return pref;
}

function AutoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v16" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

const OPTIONS: { value: Pref; label: string; Icon: () => React.JSX.Element }[] = [
  { value: 'auto', label: 'Automatisch', Icon: AutoIcon },
  { value: 'light', label: 'Hell', Icon: SunIcon },
  { value: 'dark', label: 'Dunkel', Icon: MoonIcon },
];

export default function ThemeToggle() {
  const [pref, setPref] = useState<Pref>('auto');

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Pref | null;
    if (stored === 'light' || stored === 'dark' || stored === 'auto') setPref(stored);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolve(pref));
    if (pref !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () =>
      document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const choose = (value: Pref) => {
    localStorage.setItem(STORAGE_KEY, value);
    setPref(value);
  };

  return (
    <div className="theme-toggle" role="group" aria-label="Farbschema">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          className={`theme-opt${pref === value ? ' theme-opt--active' : ''}`}
          onClick={() => choose(value)}
          title={label}
          aria-label={label}
          aria-pressed={pref === value}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}
