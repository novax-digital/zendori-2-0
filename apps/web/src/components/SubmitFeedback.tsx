'use client';

// Visible feedback for every form submit in the app, in ONE place instead of a
// pending state in each of the ~100 forms. On submit the pressed button gets
// `data-pending` (+ aria-busy); globals.css turns that into a spinner and blocks
// further clicks. The mark is removed when the work behind it is done:
//   · server actions and router navigations run over fetch — the mark clears
//     shortly after the last request started since the submit has settled
//   · a submit that starts no request at all (handled in the browser) clears
//     after IDLE_MS
//   · MAX_MS is the safety net, so a button never stays blocked
// Native full-page submits reload the document, which clears everything anyway.
import { useEffect } from 'react';

const PENDING_ATTR = 'data-pending';
const IDLE_MS = 1500;
const SETTLE_MS = 150;
const MAX_MS = 30_000;

const SUBMIT_SELECTOR = 'button[type="submit"], button:not([type]), input[type="submit"]';

function submitterOf(event: SubmitEvent, form: HTMLFormElement): HTMLElement | null {
  if (event.submitter instanceof HTMLElement) return event.submitter;
  // Enter in a field: the form's own submit button, or one outside it (form="id")
  const inside = form.querySelector<HTMLElement>(SUBMIT_SELECTOR);
  if (inside) return inside;
  if (form.id) {
    return document.querySelector<HTMLElement>(
      `button[type="submit"][form="${CSS.escape(form.id)}"]`
    );
  }
  return null;
}

export default function SubmitFeedback() {
  useEffect(() => {
    const pending = new Set<HTMLElement>();
    let inFlight = 0;
    let sawRequest = false;
    let idleTimer: number | undefined;
    let settleTimer: number | undefined;
    let maxTimer: number | undefined;

    const clearTimers = () => {
      window.clearTimeout(idleTimer);
      window.clearTimeout(settleTimer);
      window.clearTimeout(maxTimer);
    };

    const clearAll = () => {
      clearTimers();
      for (const el of pending) {
        el.removeAttribute(PENDING_ATTR);
        el.removeAttribute('aria-busy');
      }
      pending.clear();
      sawRequest = false;
    };

    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const el = submitterOf(event, form);
      if (!el) return;
      el.setAttribute(PENDING_ATTR, 'true');
      el.setAttribute('aria-busy', 'true');
      pending.add(el);
      sawRequest = false;
      clearTimers();
      idleTimer = window.setTimeout(clearAll, IDLE_MS);
      maxTimer = window.setTimeout(clearAll, MAX_MS);
      // Not prevented by React or a handler = a native page load (e.g. the GET
      // filter forms): keep the spinner until the new page replaces this one.
      window.setTimeout(() => {
        if (!event.defaultPrevented) window.clearTimeout(idleTimer);
      }, 0);
    };

    // back/forward cache restores the page with its attributes — start clean
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) clearAll();
    };

    const nativeFetch = window.fetch;
    const callFetch = nativeFetch.bind(window);
    const trackedFetch: typeof window.fetch = (...args) => {
      if (pending.size === 0) return callFetch(...args);
      inFlight += 1;
      sawRequest = true;
      window.clearTimeout(idleTimer);
      window.clearTimeout(settleTimer);
      const request = callFetch(...args);
      const done = () => {
        inFlight -= 1;
        if (inFlight === 0 && sawRequest) {
          // short grace: a redirect after an action may start one more request
          settleTimer = window.setTimeout(clearAll, SETTLE_MS);
        }
      };
      request.then(done, done);
      return request;
    };

    window.fetch = trackedFetch;
    document.addEventListener('submit', onSubmit, true);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('submit', onSubmit, true);
      window.removeEventListener('pageshow', onPageShow);
      if (window.fetch === trackedFetch) window.fetch = nativeFetch;
      clearAll();
    };
  }, []);

  return null;
}
