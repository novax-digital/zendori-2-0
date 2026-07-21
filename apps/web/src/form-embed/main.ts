import { mountLiveForm } from './controller';

/**
 * Embeddable form entry point (Phase 10). Included on customer websites via a
 * placeholder div + one script tag:
 *
 *   <div data-zendori-form="PUBLIC_TOKEN"></div>
 *   <script src="https://…/form.js" async></script>
 *
 * Unlike the chat bubble, an inline form needs an explicit mount point — the
 * div determines where the form sits in the page layout; multiple forms per
 * page are supported. Optional: data-zendori-url on the script overrides the
 * API base (default: script origin). Unknown/inactive tokens render nothing
 * (no error box on the customer's site).
 */

declare global {
  interface Window {
    __zendoriFormLoaded?: boolean;
  }
}

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

// Captured at module evaluation — inside DOMContentLoaded handlers
// document.currentScript is already null.
const ownScript = document.currentScript instanceof HTMLScriptElement ? document.currentScript : null;

/** True for the Zendori bundle itself — exact filename, not a substring
 *  (a site's own jquery.form.js/contact-form.js must never win). */
function isFormBundleSrc(src: string): boolean {
  try {
    return new URL(src, window.location.href).pathname.endsWith('/form.js');
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
    if (!isFormBundleSrc(script.src)) continue;
    const base = apiBaseFromScript(script);
    if (base) return base;
  }
  return '';
}

function mountWithRetry(host: HTMLElement, token: string, apiBase: string): void {
  void mountLiveForm(host, token, apiBase).then((mounted) => {
    if (mounted) return;
    // unknown token / API down: placeholder stays empty — retry once when the
    // browser reports connectivity again
    window.addEventListener(
      'online',
      () => {
        mountWithRetry(host, token, apiBase);
      },
      { once: true }
    );
  });
}

function init(): void {
  if (window.__zendoriFormLoaded) return;
  window.__zendoriFormLoaded = true;
  const apiBase = resolveApiBase();
  const hosts = document.querySelectorAll<HTMLElement>('[data-zendori-form]');
  hosts.forEach((host) => {
    const token = host.dataset.zendoriForm?.trim() ?? '';
    if (!TOKEN_PATTERN.test(token)) return;
    mountWithRetry(host, token, apiBase);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
