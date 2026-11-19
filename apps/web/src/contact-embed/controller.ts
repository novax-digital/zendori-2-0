import { generateSubmissionId } from '../form-embed/controller';
import { DemoApiError, postJson } from '../demo-embed/api';
import { renderContact, type ContactFieldErrors, type ContactRenderOptions } from './render';

/**
 * Contact embed controller: render into a closed shadow root right away →
 * submit → thank-you panel. The render token (bot check: proves the form was
 * rendered, min-time) is fetched in the background and only needed on submit.
 * The host gets data-zendori-state="ready" once the form is in the DOM (host
 * pages hide their loading placeholder on it).
 */

export type ContactMountOptions = ContactRenderOptions;

const NETWORK_ERROR = 'Verbindung fehlgeschlagen. Bitte versuch es erneut.';
const GENERIC_ERROR = 'Die Nachricht konnte nicht gesendet werden. Bitte versuch es erneut.';

// One mount per host (closed shadow roots cannot be re-attached).
const mountedHosts = new WeakSet<HTMLElement>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function fetchRenderToken(apiBase: string): Promise<string> {
  const data = await postJson(`${apiBase}/api/contact/bootstrap`, {});
  if (!isRecord(data) || typeof data.renderToken !== 'string') {
    throw new Error('Contact API returned an unexpected response shape');
  }
  return data.renderToken;
}

export function mountContact(host: HTMLElement, apiBase: string, options: ContactMountOptions): void {
  if (mountedHosts.has(host)) return;
  mountedHosts.add(host);

  let renderToken: string | null = null;
  let tokenRequest: Promise<string | null> | null = null;
  /** Fetches a fresh token (one request at a time); null when the API is unreachable. */
  function loadRenderToken(): Promise<string | null> {
    tokenRequest ??= fetchRenderToken(apiBase)
      .then((token) => {
        renderToken = token;
        return token;
      })
      .catch(() => null)
      .finally(() => {
        tokenRequest = null;
      });
    return tokenRequest;
  }
  void loadRenderToken();

  const shadow = host.attachShadow({ mode: 'closed' });
  // one id per filled form — reused on resubmits so the server dedupes,
  // regenerated after success
  let clientRequestId = generateSubmissionId();
  let submitting = false;

  const ui = renderContact(shadow, options, { onSubmit: () => void handleSubmit() });
  host.setAttribute('data-zendori-state', 'ready');

  async function handleSubmit(): Promise<void> {
    if (submitting) return;
    ui.showBanner(null);
    if (!ui.validate()) return;
    const values = ui.readValues();
    submitting = true;
    ui.setSubmitting(true);
    try {
      const token = renderToken ?? (await loadRenderToken());
      if (!token) {
        ui.showBanner(NETWORK_ERROR);
        return;
      }
      await postJson(`${apiBase}/api/contact/submit`, {
        renderToken: token,
        clientRequestId,
        name: values.name,
        email: values.email,
        company: values.company,
        phone: values.phone,
        topic: values.topic,
        message: values.message,
        consent: true,
        nickname: values.nickname,
      });
      clientRequestId = generateSubmissionId();
      ui.showSuccess(() => {
        void loadRenderToken();
        ui.showEmptyForm();
      });
    } catch (error) {
      if (error instanceof DemoApiError) {
        if (error.code === 'render_expired') {
          // stale tab: refresh the token silently, the visitor just resubmits
          renderToken = null;
          await loadRenderToken();
          ui.showBanner('Bitte sende das Formular erneut ab.');
        } else {
          if (Object.keys(error.rawFields).length > 0) {
            ui.setFieldErrors(error.rawFields as ContactFieldErrors);
          }
          ui.showBanner(error.serverMessage ?? GENERIC_ERROR);
        }
      } else {
        ui.showBanner(error instanceof TypeError ? NETWORK_ERROR : GENERIC_ERROR);
      }
    } finally {
      submitting = false;
      ui.setSubmitting(false);
    }
  }
}
