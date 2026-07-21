import { fetchFormBootstrap, FormApiError, submitForm } from './api';
import { renderForm } from './render';

/**
 * Live-form controller shared by the embed bundle (form.js) and the hosted
 * page /f/[token]: bootstrap → render into a shadow root → orchestrate submit
 * with honeypot, render-token refresh and one network retry. Returns false
 * when the bootstrap failed (caller decides how to react).
 */

const RENDER_TOKEN_RETRY_DELAY_MS = 3_200;
const NETWORK_RETRY_DELAY_MS = 1_500;

// One mount per host: element.shadowRoot is ALWAYS null for closed roots, so
// a second attachShadow would throw (e.g. React StrictMode double-effect on
// the hosted page). The WeakSet makes repeat mounts a no-op.
const mountedHosts = new WeakSet<HTMLElement>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function generateSubmissionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex: string[] = [];
  bytes.forEach((byte) => hex.push(byte.toString(16).padStart(2, '0')));
  return (
    `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-` +
    `${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  );
}

export async function mountLiveForm(
  host: HTMLElement,
  token: string,
  apiBase: string
): Promise<boolean> {
  if (mountedHosts.has(host)) return true;
  mountedHosts.add(host);

  let bootstrap;
  try {
    bootstrap = await fetchFormBootstrap(apiBase, token);
  } catch {
    // allow a later retry (online listener) to mount again
    mountedHosts.delete(host);
    return false;
  }
  let renderToken = bootstrap.renderToken;

  const shadow = host.attachShadow({ mode: 'closed' });
  // one submission id per fill attempt — reused on retries so the server
  // dedupes, regenerated after success
  let clientSubmissionId = generateSubmissionId();

  const handles = renderForm(shadow, bootstrap.definition, {
    mode: 'live',
    onSubmit: () => {
      void handleSubmit();
    },
  });

  async function attemptSubmit(): Promise<'ok' | 'render_token' | 'retryable' | 'failed'> {
    try {
      await submitForm(apiBase, {
        token,
        clientSubmissionId,
        renderToken,
        values: handles.readValues(),
      });
      return 'ok';
    } catch (error) {
      if (error instanceof FormApiError) {
        if (error.code === 'render_token') return 'render_token';
        if (error.status === 429 || error.status >= 500) return 'retryable';
        return 'failed';
      }
      return 'retryable'; // network-level failure
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!handles.validate()) return;
    if (handles.honeypotValue().length > 0) {
      // filled honeypot → pretend success (mirror the server's silent discard)
      handles.showSuccess();
      return;
    }
    handles.showBanner(null);
    handles.setSubmitting(true);

    let outcome = await attemptSubmit();

    if (outcome === 'render_token') {
      // token expired (old tab) or too fast — transparently re-bootstrap,
      // respect the min-time window, retry once; inputs stay in the DOM
      try {
        const fresh = await fetchFormBootstrap(apiBase, token);
        renderToken = fresh.renderToken;
        await delay(RENDER_TOKEN_RETRY_DELAY_MS);
        outcome = await attemptSubmit();
      } catch {
        outcome = 'retryable';
      }
    } else if (outcome === 'retryable') {
      await delay(NETWORK_RETRY_DELAY_MS);
      outcome = await attemptSubmit();
    }

    handles.setSubmitting(false);
    if (outcome === 'ok') {
      handles.showSuccess();
      clientSubmissionId = generateSubmissionId();
      return;
    }
    handles.showBanner(
      outcome === 'failed'
        ? 'Bitte Eingaben prüfen und erneut versuchen. Falls das Formular gerade aktualisiert wurde, laden Sie die Seite bitte neu.'
        : 'Senden gerade nicht möglich — bitte später erneut versuchen.'
    );
  }

  return true;
}
