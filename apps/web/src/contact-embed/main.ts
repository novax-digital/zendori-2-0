import { mountContact } from './controller';
import type { ContactMountOptions } from './controller';

/**
 * Embeddable contact form (Kontaktanfragen, docs/contact-requests.md).
 * Included on the marketing site via a placeholder div + one script tag:
 *
 *   <div data-zendori-contact></div>
 *   <script src="https://app.zendori.ai/contact.js" async></script>
 *
 * Optional div attributes: data-accent (#rgb / #rrggbb — replaces the brand
 * gradient with one solid color), data-title (shows a head with that title —
 * by default the host page brings its own heading), data-privacy-url (http(s)
 * link in the consent text). Optional on the script: data-zendori-url
 * overrides the API base (default: script origin). The form paints as soon as
 * the script runs and marks its placeholder with data-zendori-state="ready".
 */

declare global {
  interface Window {
    __zendoriContactLoaded?: boolean;
  }
}

// Captured at module evaluation — inside DOMContentLoaded handlers
// document.currentScript is already null.
const ownScript = document.currentScript instanceof HTMLScriptElement ? document.currentScript : null;

/** True for the Zendori bundle itself — exact filename, not a substring. */
function isContactBundleSrc(src: string): boolean {
  try {
    return new URL(src, window.location.href).pathname.endsWith('/contact.js');
  } catch {
    return false;
  }
}

function apiBaseFromScript(script: HTMLScriptElement): string | null {
  const explicit = script.dataset.zendoriUrl?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  try {
    return new URL(script.src).origin;
  } catch {
    return null;
  }
}

function resolveApiBase(): string {
  if (ownScript) {
    const base = apiBaseFromScript(ownScript);
    if (base) return base;
  }
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[src]');
  for (const script of scripts) {
    if (!isContactBundleSrc(script.src)) continue;
    const base = apiBaseFromScript(script);
    if (base) return base;
  }
  return '';
}

/** #rgb / #rrggbb only (expanded to #rrggbb); absent/anything else → null (brand gradient). */
function parseAccent(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

function readOptions(host: HTMLElement): ContactMountOptions {
  const title = host.dataset.title?.trim();
  const privacy = host.dataset.privacyUrl?.trim();
  return {
    accent: parseAccent(host.dataset.accent),
    title: title && title.length > 0 ? title.slice(0, 120) : null,
    privacyUrl: privacy && /^https?:\/\//i.test(privacy) ? privacy : null,
  };
}

function init(): void {
  if (window.__zendoriContactLoaded) return;
  window.__zendoriContactLoaded = true;
  const apiBase = resolveApiBase();
  document.querySelectorAll<HTMLElement>('[data-zendori-contact]').forEach((host) => {
    mountContact(host, apiBase, readOptions(host));
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
