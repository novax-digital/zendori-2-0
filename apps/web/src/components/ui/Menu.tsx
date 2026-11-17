'use client';

// Menu (redesign stage 3): the "⋯" button with a small popover. Home of rare
// and destructive actions, so page heads and table rows stay calm.
//   <Menu label="Weitere Aktionen">
//     <Link className="menu-item" href={…}>In der Inbox öffnen</Link>
//     <form action={deleteAgent}>
//       <input type="hidden" name="agentId" value={agent.id} />
//       <button className="menu-item menu-item--danger" type="submit">Löschen</button>
//     </form>
//   </Menu>
// The popover is position: fixed (placed under the button when it opens), so
// a scrolling table or an overflow: hidden parent never clips it.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Icon from './Icon';
import { useDismiss } from './useDismiss';

export default function Menu({
  label = 'Weitere Aktionen',
  children,
}: {
  /** Accessible name of the trigger button. */
  label?: string;
  /** Menu entries: links, buttons or forms with a submit button, class "menu-item". */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const wrap = useDismiss<HTMLSpanElement>(open, setOpen);
  const trigger = useRef<HTMLButtonElement>(null);

  // The fixed popover does not follow the page — close it when the page moves.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = () => {
    if (!open && trigger.current) {
      const rect = trigger.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
    }
    setOpen((value) => !value);
  };

  return (
    <span className="menu" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="btn btn--ghost btn--icon"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
      >
        <Icon name="more" />
      </button>
      {open && position ? (
        <div
          className="menu-pop"
          // runtime value: where the trigger currently sits in the viewport
          style={{ top: position.top, right: position.right }}
          onClick={(event) => {
            // links navigate away; forms must stay mounted until they have submitted
            if ((event.target as HTMLElement).closest('a')) setOpen(false);
          }}
        >
          {children}
        </div>
      ) : null}
    </span>
  );
}
