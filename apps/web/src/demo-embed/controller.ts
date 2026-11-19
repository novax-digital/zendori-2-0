import { generateSubmissionId } from '../form-embed/controller';
import {
  DemoApiError,
  fetchDemoStatus,
  fetchRenderToken,
  resendDemoCode,
  submitDemoRequest,
  verifyDemoCode,
} from './api';
import { renderDemo } from './render';
import type { DemoMountOptions, DemoPublicStatus, DemoVerifyChannel } from './types';

/**
 * Demo embed controller: bootstrap (render token) → render into a closed
 * shadow root → submit (server sends an SMS/voice code to the number) → code
 * step → success panel with live status polling. Returns false when the
 * bootstrap failed so the caller can retry later (the placeholder stays
 * empty — no error box on the host site).
 */

const POLL_INTERVAL_MS = 4_000;
const POLL_MAX_MS = 45 * 60 * 1000;
const POLL_MAX_FAILURES = 5;
/** Mirrors DEMO_CODE_RESEND_COOLDOWN_SECONDS (server-enforced). */
const RESEND_COOLDOWN_SECONDS = 30;

const STATUS_TEXT: Record<DemoPublicStatus, string> = {
  awaiting_confirmation: 'Wartet auf deinen Bestätigungscode …',
  queued: 'Bestätigt – dein Anruf wird vorbereitet …',
  calling: 'Dein Telefon klingelt gleich – bitte nimm ab.',
  in_call: 'Der Demo-Anruf läuft.',
  completed: 'Danke! Der Demo-Anruf ist beendet. Wir melden uns bei dir.',
  no_answer: 'Du hast leider nicht abgenommen. Fordere die Demo gern erneut an.',
  busy: 'Deine Leitung war besetzt. Fordere die Demo gern erneut an.',
  failed: 'Der Anruf konnte nicht durchgeführt werden. Bitte versuch es später erneut.',
  expired: 'Die Anfrage ist abgelaufen. Bitte fordere die Demo erneut an.',
};

const TERMINAL: readonly DemoPublicStatus[] = [
  'completed',
  'no_answer',
  'busy',
  'failed',
  'expired',
];

const NETWORK_ERROR = 'Verbindung fehlgeschlagen. Bitte versuch es erneut.';
/** Codes after which the request can never be verified any more. */
const FATAL_CODE_ERRORS = [
  'expired',
  'too_many_attempts',
  'not_found',
  'request_limit',
  'phone_limit',
  'daily_limit',
];
const GENERIC_ERROR = 'Die Anfrage konnte nicht gesendet werden. Bitte versuch es erneut.';

// One mount per host (closed shadow roots cannot be re-attached).
const mountedHosts = new WeakSet<HTMLElement>();

export async function mountDemo(
  host: HTMLElement,
  apiBase: string,
  options: DemoMountOptions
): Promise<boolean> {
  if (mountedHosts.has(host)) return true;
  mountedHosts.add(host);

  let renderToken: string;
  try {
    renderToken = await fetchRenderToken(apiBase);
  } catch {
    mountedHosts.delete(host); // allow the 'online' retry to mount again
    return false;
  }

  const shadow = host.attachShadow({ mode: 'closed' });
  // one id per fill attempt — reused on resubmits so the server dedupes,
  // regenerated after success
  let clientRequestId = generateSubmissionId();
  let submitting = false;
  let verifying = false;
  let resending = false;
  let pollTimer: number | null = null;
  let statusToken: string | null = null;
  let cooldownTimer: number | null = null;
  let resendExhausted = false;

  const ui = renderDemo(shadow, options, {
    onSubmit: () => void handleSubmit(),
    onVerify: () => void handleVerify(),
    onResend: (channel) => void handleResend(channel),
    onChangeNumber: () => void changeNumber(),
  });

  function stopCooldown(): void {
    if (cooldownTimer !== null) {
      window.clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  }

  function startCooldown(seconds: number): void {
    stopCooldown();
    const until = Date.now() + seconds * 1000;
    const tick = (): void => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      ui.setResendState({ secondsLeft: left, exhausted: resendExhausted });
      if (left === 0) stopCooldown();
    };
    tick();
    cooldownTimer = window.setInterval(tick, 1000);
  }

  function stopPolling(): void {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function showStatus(status: DemoPublicStatus): boolean {
    const terminal = TERMINAL.includes(status);
    ui.setStatus(STATUS_TEXT[status], !terminal);
    if (terminal && status !== 'completed') {
      ui.setReset(() => {
        void resetForm();
      });
    }
    return terminal;
  }

  function startPolling(token: string): void {
    stopPolling();
    const startedAt = Date.now();
    let failures = 0;
    let inFlight = false;
    pollTimer = window.setInterval(() => {
      if (Date.now() - startedAt > POLL_MAX_MS) {
        stopPolling();
        return;
      }
      if (document.hidden || inFlight) return;
      inFlight = true;
      fetchDemoStatus(apiBase, token)
        .then((status) => {
          failures = 0;
          if (showStatus(status)) stopPolling();
        })
        .catch(() => {
          // keep the last shown state; give up after repeated failures
          failures += 1;
          if (failures >= POLL_MAX_FAILURES) stopPolling();
        })
        .finally(() => {
          inFlight = false;
        });
    }, POLL_INTERVAL_MS);
  }

  async function resetForm(): Promise<void> {
    stopPolling();
    stopCooldown();
    statusToken = null;
    try {
      renderToken = await fetchRenderToken(apiBase);
    } catch {
      // keep the old token; a stale one is answered with render_expired and refreshed then
    }
    ui.showEmptyForm();
  }

  async function handleSubmit(): Promise<void> {
    if (submitting) return;
    ui.showBanner(null);
    if (!ui.validate()) return;
    const values = ui.readValues();
    submitting = true;
    ui.setSubmitting(true);
    try {
      const result = await submitDemoRequest(apiBase, {
        renderToken,
        clientRequestId,
        company: values.company,
        contactName: values.contactName,
        email: values.email,
        phone: values.phone,
        websiteUrl: values.websiteUrl,
        prompt: values.prompt,
        consent: true,
        nickname: values.nickname,
      });
      clientRequestId = generateSubmissionId();
      statusToken = result.statusToken;
      resendExhausted = false;
      ui.showCodeStep(result.phone, result.channel);
      startCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (error) {
      if (error instanceof DemoApiError) {
        if (error.code === 'render_expired') {
          // stale tab: refresh the token silently, the user just resubmits
          try {
            renderToken = await fetchRenderToken(apiBase);
          } catch {
            // next submit will surface the error again
          }
          ui.showBanner('Bitte sende das Formular erneut ab.');
        } else {
          if (Object.keys(error.fields).length > 0) ui.setFieldErrors(error.fields);
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

  function showVerified(status: DemoPublicStatus): void {
    stopCooldown();
    if (status === 'expired') {
      // closed without verification (window over / other tab) — never "bestätigt"
      ui.showCodeFatal(STATUS_TEXT.expired, () => void resetForm());
      return;
    }
    ui.showSuccess();
    if (!showStatus(status) && statusToken) startPolling(statusToken);
  }

  /** Error during the code step: inline, or final with a reset button. */
  function showCodeStepError(error: unknown): void {
    if (error instanceof DemoApiError) {
      const message = error.serverMessage ?? GENERIC_ERROR;
      if (error.code && FATAL_CODE_ERRORS.includes(error.code)) {
        stopCooldown();
        ui.showCodeFatal(message, () => void resetForm());
        return;
      }
      if (error.code === 'cooldown' && error.retryAfterSeconds) {
        startCooldown(error.retryAfterSeconds);
      }
      if (error.code === 'resend_limit') {
        resendExhausted = true;
        ui.setResendState({ secondsLeft: 0, exhausted: true });
      }
      ui.setCodeError(message);
      return;
    }
    ui.setCodeError(error instanceof TypeError ? NETWORK_ERROR : GENERIC_ERROR);
  }

  async function handleVerify(): Promise<void> {
    if (verifying || !statusToken) return;
    const code = ui.readCode();
    if (!/^\d{4,10}$/.test(code)) {
      ui.setCodeError('Bitte gib den Code aus der SMS ein (nur Ziffern).');
      return;
    }
    verifying = true;
    ui.setVerifying(true);
    ui.setCodeError(null);
    try {
      const status = await verifyDemoCode(apiBase, statusToken, code);
      showVerified(status);
    } catch (error) {
      showCodeStepError(error);
    } finally {
      verifying = false;
      ui.setVerifying(false);
    }
  }

  async function handleResend(channel: DemoVerifyChannel): Promise<void> {
    if (resending || !statusToken) return;
    resending = true;
    ui.setCodeError(null);
    ui.setCodeInfo(null);
    try {
      const result = await resendDemoCode(apiBase, statusToken, channel);
      if ('status' in result) {
        if (result.status === 'awaiting_confirmation') return;
        showVerified(result.status);
        return;
      }
      ui.setCodeChannel(result.channel);
      resendExhausted = result.sendsLeft <= 0;
      ui.setCodeInfo(
        result.channel === 'sms'
          ? 'Ein neuer Code ist per SMS unterwegs.'
          : 'Du bekommst gleich einen Anruf mit deinem Code.'
      );
      startCooldown(result.resendAfterSeconds);
    } catch (error) {
      showCodeStepError(error);
    } finally {
      resending = false;
    }
  }

  /** "Nummer ändern": back to the filled form; a submit creates a fresh request. */
  async function changeNumber(): Promise<void> {
    stopCooldown();
    statusToken = null;
    try {
      renderToken = await fetchRenderToken(apiBase);
    } catch {
      // a stale token is answered with render_expired and refreshed then
    }
    ui.showForm();
  }

  return true;
}
