import { createOrResumeSession, fetchBootstrap, sendWidgetMessage, WidgetApiError } from './api';
import { RealtimeConnection } from './realtime';
import {
  clearStoredSession,
  isContactPromptDone,
  loadStoredSession,
  markContactPromptDone,
  saveStoredSession,
} from './storage';
import { createWidgetUi } from './ui';
import type { BubbleHandle } from './ui';
import type {
  BootstrapResponse,
  ContactDetails,
  HistoryMessage,
  SessionResponse,
  WidgetConfig,
} from './types';

/**
 * Embeddable chat widget entry point. Included on customer websites via a
 * single script tag:
 *
 *   <script src="https://…/widget.js" data-zendori-token="TOKEN" async></script>
 *
 * Optional: data-zendori-url overrides the API base (default: script origin).
 */

declare global {
  interface Window {
    __zendoriWidgetLoaded?: boolean;
  }
}

type OutgoingMessage = {
  clientMessageId: string;
  content: string;
  bubble: BubbleHandle;
};

const SEND_ATTEMPTS = 3;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RETRY_DELAY_START_MS = 15_000;
const RETRY_DELAY_MAX_MS = 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function generateClientMessageId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // fallback for non-secure contexts (crypto.randomUUID needs HTTPS/localhost)
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

function findOwnScript(): HTMLScriptElement | null {
  const current = document.currentScript;
  if (current instanceof HTMLScriptElement && current.dataset.zendoriToken) return current;
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[data-zendori-token]');
  return scripts.length > 0 ? (scripts[scripts.length - 1] ?? null) : null;
}

function resolveConfig(): WidgetConfig | null {
  const script = findOwnScript();
  if (!script) return null;
  const token = script.dataset.zendoriToken?.trim() ?? '';
  if (!token) return null;
  const explicitBase = script.dataset.zendoriUrl?.trim();
  let apiBase = '';
  if (explicitBase) {
    apiBase = explicitBase.replace(/\/+$/, '');
  } else if (script.src) {
    try {
      apiBase = new URL(script.src, window.location.href).origin;
    } catch {
      apiBase = '';
    }
  }
  if (!apiBase) apiBase = window.location.origin;
  return { token, apiBase };
}

async function bootstrapWithRetry(
  config: WidgetConfig
): Promise<BootstrapResponse | 'not-found' | 'unavailable'> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await delay(1000 * attempt);
    try {
      return await fetchBootstrap(config);
    } catch (error) {
      // unknown/inactive token → widget stays invisible, no retries
      if (
        error instanceof WidgetApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429
      ) {
        return 'not-found';
      }
    }
  }
  return 'unavailable';
}

async function initialize(config: WidgetConfig): Promise<void> {
  const bootData = await bootstrapWithRetry(config);
  if (bootData === 'not-found') return;
  if (bootData === 'unavailable') {
    // try again once connectivity returns
    window.addEventListener(
      'online',
      () => {
        void initialize(config);
      },
      { once: true }
    );
    return;
  }
  mount(config, bootData);
}

function mount(config: WidgetConfig, bootData: BootstrapResponse): void {
  const host = document.createElement('div');
  host.setAttribute('data-zendori-widget', '');
  const shadow = host.attachShadow({ mode: 'closed' });
  document.body.appendChild(host);

  const queue: OutgoingMessage[] = [];
  const renderedIds = new Set<string>();
  let flushing = false;
  let refreshAfterFlush = false;
  let retryTimer: number | null = null;
  let retryDelayMs = RETRY_DELAY_START_MS;
  let activeSession: { conversationId: string; secret: string } | null = null;
  let sessionFlight: Promise<SessionResponse | null> | null = null;

  const ui = createWidgetUi(shadow, bootData.theme, {
    onSend: (content) => {
      enqueueMessage(content);
    },
    onContactSave: (name, email) => saveContact(name, email),
    onContactSkip: () => {
      markContactPromptDone(config.token);
    },
  });

  const realtime = new RealtimeConnection(bootData.realtime, handleReply);

  function handleReply(message: HistoryMessage): void {
    if (message.content_type !== 'text') return;
    if (renderedIds.has(message.id)) return;
    renderedIds.add(message.id);
    ui.addAgentMessage(message.content);
  }

  /**
   * POSTs /api/widget/session (with resume credentials when present), stores
   * the session and (re-)joins the broadcast topic. Concurrent callers share
   * one in-flight request. An expired resume clears the stored session and
   * resolves to null — the widget then behaves like a first-time visitor and
   * a later call (without resume) creates the fresh session.
   */
  function requestSession(): Promise<SessionResponse | null> {
    if (sessionFlight) return sessionFlight;
    const flight = (async (): Promise<SessionResponse | null> => {
      try {
        const stored = loadStoredSession(config.token);
        const result = await createOrResumeSession(config, stored);
        if (result === 'expired') {
          activeSession = null;
          clearStoredSession(config.token);
          return null;
        }
        const secret = result.secret || stored?.secret || '';
        activeSession = { conversationId: result.conversationId, secret };
        saveStoredSession(config.token, activeSession);
        realtime.subscribe(result.topic);
        return result;
      } finally {
        sessionFlight = null;
      }
    })();
    sessionFlight = flight;
    return flight;
  }

  /** Rebuilds the message list from server history, then re-appends unsent local messages. */
  function renderHistory(history: HistoryMessage[]): void {
    renderedIds.clear();
    ui.resetMessages();
    for (const message of history) {
      if (message.content_type !== 'text') continue;
      renderedIds.add(message.id);
      if (message.sender_type === 'contact') {
        ui.addContactMessage(message.content).setState('sent');
      } else {
        ui.addAgentMessage(message.content, { notify: false });
      }
    }
    for (const item of queue) {
      item.bubble = ui.addContactMessage(item.content);
    }
  }

  /** Resume: reload history + resubscribe (initial load and 'online' event). */
  async function refreshFromServer(attempts: number): Promise<void> {
    if (flushing) {
      // never rebuild the message list while a flush is running — the reload
      // is picked up again right after the flush finishes
      refreshAfterFlush = true;
      return;
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await delay(1500 * attempt);
      try {
        const result = await requestSession();
        if (!result) {
          // expired session was discarded — continue as a first-time visitor
          ui.setOffline(false);
          return;
        }
        renderHistory(result.messages);
        ui.setOffline(false);
        void flushQueue();
        return;
      } catch {
        // 503/network error: KEEP the stored session, retry with backoff,
        // then leave the offline banner visible until the next occasion
      }
    }
    ui.setOffline(true);
  }

  function enqueueMessage(content: string): void {
    queue.push({
      clientMessageId: generateClientMessageId(),
      content,
      bubble: ui.addContactMessage(content),
    });
    void flushQueue();
  }

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  /** Backoff timer that re-attempts the queue flush (15 s → 30 s → 60 s → 60 s …). */
  function scheduleRetry(): void {
    if (retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void flushQueue();
    }, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_DELAY_MAX_MS);
  }

  async function flushQueue(): Promise<void> {
    if (flushing) return;
    flushing = true;
    clearRetryTimer();
    let retryLater = false;
    try {
      while (queue.length > 0) {
        const item = queue[0];
        if (!item) break;
        item.bubble.setState('sending');
        const outcome = await trySend(item);
        if (outcome === 'retry-later') {
          // stays queued — retried by the backoff timer, the next 'online'
          // event or the next send
          item.bubble.setState('failed');
          ui.setOffline(true);
          retryLater = true;
          return;
        }
        queue.shift();
        if (outcome === 'sent') {
          item.bubble.setState('sent');
          ui.setOffline(false);
          if (!isContactPromptDone(config.token)) ui.showContactPrompt();
        } else {
          item.bubble.setState('failed');
        }
      }
      // queue drained — reset the backoff for the next outage
      retryDelayMs = RETRY_DELAY_START_MS;
    } finally {
      flushing = false;
      if (retryLater) scheduleRetry();
      if (refreshAfterFlush) {
        // history reload deferred by a concurrent flush (see refreshFromServer)
        refreshAfterFlush = false;
        void refreshFromServer(3);
      }
    }
  }

  /**
   * Sends one message with up to SEND_ATTEMPTS attempts (backoff, SAME
   * clientMessageId — the server dedupes redeliveries via external_id).
   */
  async function trySend(item: OutgoingMessage): Promise<'sent' | 'rejected' | 'retry-later'> {
    for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await delay(1500 * attempt);
      try {
        if (!activeSession) await requestSession();
        const session = activeSession;
        if (!session) continue;
        await sendWidgetMessage(config, session, {
          clientMessageId: item.clientMessageId,
          content: item.content,
        });
        return 'sent';
      } catch (error) {
        if (error instanceof WidgetApiError) {
          if (error.status === 401 || error.status === 404) {
            // stale/invalid session — the next attempt creates a fresh one
            activeSession = null;
            clearStoredSession(config.token);
            continue;
          }
          if (error.status === 400) return 'rejected';
          continue; // 429 / 5xx → backoff and retry
        }
        ui.setOffline(true); // network-level failure
      }
    }
    return 'retry-later';
  }

  async function saveContact(name: string, email: string): Promise<string | null> {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName && !trimmedEmail) return 'Bitte Name oder E-Mail-Adresse angeben.';
    if (trimmedEmail && !EMAIL_PATTERN.test(trimmedEmail)) {
      return 'Bitte eine gültige E-Mail-Adresse angeben.';
    }
    try {
      if (!activeSession) await requestSession();
      const session = activeSession;
      if (!session) throw new Error('No widget session available');
      const contact: ContactDetails = {};
      if (trimmedName) contact.name = trimmedName;
      if (trimmedEmail) contact.email = trimmedEmail;
      // contact-only message: updates the contact, no chat message is created
      await sendWidgetMessage(config, session, {
        clientMessageId: generateClientMessageId(),
        contact,
      });
      markContactPromptDone(config.token);
      return null;
    } catch (error) {
      if (error instanceof WidgetApiError && error.status === 400) {
        return 'Bitte eine gültige E-Mail-Adresse angeben.';
      }
      return 'Speichern hat leider nicht geklappt — bitte versuchen Sie es später erneut.';
    }
  }

  window.addEventListener('offline', () => {
    ui.setOffline(true);
  });
  window.addEventListener('online', () => {
    if (activeSession || loadStoredSession(config.token)) {
      // re-join the broadcast channel and reload history to catch missed replies
      void refreshFromServer(3);
    } else {
      ui.setOffline(false);
      void flushQueue();
    }
  });

  // resume an existing session on load: render history + subscribe
  if (loadStoredSession(config.token)) {
    void refreshFromServer(3);
  }
}

function boot(): void {
  if (window.__zendoriWidgetLoaded) return;
  const config = resolveConfig();
  if (!config) return;
  window.__zendoriWidgetLoaded = true;
  const start = (): void => {
    void initialize(config);
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

boot();
