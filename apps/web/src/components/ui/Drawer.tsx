'use client';

// Drawer (redesign stage 3, docs/design-redesign.md §4): the place where
// things are created and edited. It slides in from the right over the list
// it belongs to. Open/closed lives in the URL, so pages stay server components:
//
//   const { panel } = await searchParams;
//   …
//   {panel === 'new' ? (
//     <Drawer
//       title="Neuer Kanal"
//       closeHref={`/settings/channels?org=${orgId}`}
//       footer={
//         <>
//           <Button href={`/settings/channels?org=${orgId}`}>Abbrechen</Button>
//           <Button type="submit" form="new-channel" variant="primary">Kanal anlegen</Button>
//         </>
//       }
//     >
//       <form id="new-channel" action={createChannel} className="stack">…</form>
//     </Drawer>
//   ) : null}
//
// The footer buttons sit outside the <form>; they reach it with the native
// `form="…"` attribute. Client part: Escape closes, focus moves into the
// drawer and is kept there, the page behind does not scroll.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Icon from './Icon';

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
const FIRST_FIELD =
  '[autofocus], input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)';

export default function Drawer({
  title,
  closeHref,
  footer,
  children,
}: {
  title: ReactNode;
  /** The same page without the panel parameter. */
  closeHref: string;
  /** Left: optional note (.drawer-foot-note). Right: Abbrechen, then the primary button. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();

  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (node.querySelector<HTMLElement>(FIRST_FIELD) ?? node).focus();
    const { body } = document;
    const overflow = body.style.overflow;
    body.style.overflow = 'hidden';

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        router.push(closeHref, { scroll: false });
        return;
      }
      if (event.key !== 'Tab') return;
      const items = node.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      body.style.overflow = overflow;
      previous?.focus();
    };
  }, [closeHref, router]);

  return (
    <div className="drawer-root">
      {/* click outside closes; keyboard and screen readers use the button in the head */}
      <Link
        className="drawer-scrim"
        href={closeHref}
        scroll={false}
        tabIndex={-1}
        aria-hidden="true"
      />
      <aside
        ref={panel}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="drawer-head">
          <h2 id={titleId}>{title}</h2>
          <Link
            href={closeHref}
            scroll={false}
            className="btn btn--ghost btn--icon"
            aria-label="Schließen"
          >
            <Icon name="close" size={18} />
          </Link>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </aside>
    </div>
  );
}
