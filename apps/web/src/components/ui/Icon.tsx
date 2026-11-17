// The one icon set of the app (redesign stage 3, docs/design-redesign.md §9):
// inline stroke SVGs on a 24 grid, 16px by default, stroke 1.8, currentColor.
// Always decorative (aria-hidden) — the surrounding control carries the label.
// No hooks, so it works in server and client components alike.
import type { ReactNode } from 'react';

const ICONS = {
  // navigation
  inbox: (
    <>
      <path d="M4 13h4l1.5 3h5L16 13h4" />
      <path d="M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7l-1.5 5a2 2 0 0 1-2 1.5H7.5a2 2 0 0 1-2-1.5L4 13Z" />
    </>
  ),
  ticket: (
    <>
      <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7Z" />
      <path d="M14 5v14" strokeDasharray="2 2" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" />
      <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20" />
    </>
  ),
  form: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </>
  ),
  channels: <path d="M10 3 8 21M16 3l-2 18M4 8h17M3 16h17" />,
  ai: (
    <>
      <path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4L12 3Z" />
      <path d="M18 15l.9 2.3L21 18l-2.1.7L18 21l-.9-2.3L15 18l2.1-.7L18 15Z" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 6a3 3 0 0 1 0 6M17 20a6 6 0 0 0-2-4.7" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v5c0 4.4-2.9 7.9-7 9-4.1-1.1-7-4.6-7-9V6l7-3Z" />
      <path d="m9.5 12 1.8 1.8L15 10" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v2.4M12 18.6V21M21 12h-2.4M5.4 12H3M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7M18.4 18.4l-1.7-1.7M7.3 7.3 5.6 5.6" />
    </>
  ),
  // controls
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  check: <path d="m5 12 5 5 9-10" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="m14.5 7.5 3 3" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.5h6.4a1.5 1.5 0 0 0 1.5-1.5l.8-12" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  collapse: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  signout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 12H4M8 8l-4 4 4 4" />,
  // callouts
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  success: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4 3 19h18L12 4Z" />
      <path d="M12 10v4M12 16.5h.01" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5M12 16h.01" />
    </>
  ),
  // channel marks (same shapes as the former channel tiles)
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  webform: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9h10M7 12.5h10M7 16h5" />
      <path d="M3 7.5h18" />
    </>
  ),
  whatsapp: (
    <>
      <path d="M4 20l1.4-4A7.5 7.5 0 1 1 8 18.6L4 20Z" />
      <path d="M9.2 9c-.3 1.4 1 3.4 2.2 4.4 1.3 1 2.6 1.2 3.4.9" />
    </>
  ),
  phone: (
    <path d="M5 4h3l1.5 4.5L7.5 10a11 11 0 0 0 6 6l1.5-2 4.5 1.5V19a2 2 0 0 1-2.2 2A16 16 0 0 1 3 6.2 2 2 0 0 1 5 4Z" />
  ),
  chat: (
    <>
      <path d="M5 5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 4V7a2 2 0 0 1 2-2Z" />
      <path d="M8.5 10h7M8.5 13h4" />
    </>
  ),
  flask: (
    <>
      <path d="M9 3h6M10 3v6l-4.5 8A2 2 0 0 0 7.3 20h9.4a2 2 0 0 0 1.8-3L14 9V3" />
      <path d="M8 15h8" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

/** Icons drawn with a heavier stroke so they read at 16px. */
const STROKE: Partial<Record<IconName, number>> = {
  chevronDown: 2,
  chevronRight: 2,
  check: 2,
  plus: 2,
  close: 2,
  more: 3,
};

export default function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  /** Edge length in px. 16 in navigation, buttons and text; 14 in dense spots. */
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE[name] ?? 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}
