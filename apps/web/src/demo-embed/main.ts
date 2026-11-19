import { mountDemo } from './controller';
import type { DemoMountOptions } from './types';

/**
 * Embeddable Demo-Anruf form (docs/demo-call.md). Included on any website via
 * a placeholder div + one script tag:
 *
 *   <div data-zendori-demo></div>
 *   <script src="https://app.zendori.ai/demo.js" async></script>
 *
 * Optional div attributes: data-accent (#rgb / #rrggbb), data-title (heading),
 * data-privacy-url (http(s) link in the consent text). Optional on the script:
 * data-zendori-url overrides the API base (default: script origin). Multiple
 * mounts per page are supported. If the API is unreachable at bootstrap the
 * placeholder stays empty (no error box on the host site).
 */

declare global {
  interface Window {
    __zendoriDemoLoaded?: boolean;
  }
}

const DEFAULT_ACCENT = '#12c7c4';
const DEFAULT_TITLE = 'Erleben Sie Zendori am Telefon';

// Captured at module evaluation — inside DOMContentLoaded handlers
// document.currentScript is already null.
const ownScript = document.currentScript instanceof HTMLScriptElement ? document.currentScript : null;

/** True for the Zendori bundle itself — exact filename, not a substring (a site's own xdemo.js must never win). */
function isDemoBundleSrc(src: string): boolean {
  try {
    return new URL(src, window.location.href).pathname.endsWith('/demo.js');
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
    if (!isDemoBundleSrc(script.src)) continue;
    const base = apiBaseFromScript(script);
    if (base) return base;
  }
  return '';
}

/** #rgb / #rrggbb only (expanded to #rrggbb), anything else → default. */
function parseAccent(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : DEFAULT_ACCENT;
}

function readOptions(host: HTMLElement): DemoMountOptions {
  const title = host.dataset.title?.trim();
  const privacy = host.dataset.privacyUrl?.trim();
  return {
    accent: parseAccent(host.dataset.accent),
    title: title && title.length > 0 ? title.slice(0, 120) : DEFAULT_TITLE,
    privacyUrl: privacy && /^https?:\/\//i.test(privacy) ? privacy : null,
  };
}

function mountWithRetry(host: HTMLElement, apiBase: string): void {
  void mountDemo(host, apiBase, readOptions(host)).then((mounted) => {
    if (mounted) return;
    // API down: placeholder stays empty — retry once connectivity returns
    window.addEventListener('online', () => mountWithRetry(host, apiBase), { once: true });
  });
}

function init(): void {
  if (window.__zendoriDemoLoaded) return;
  window.__zendoriDemoLoaded = true;
  const apiBase = resolveApiBase();
  document.querySelectorAll<HTMLElement>('[data-zendori-demo]').forEach((host) => {
    mountWithRetry(host, apiBase);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
