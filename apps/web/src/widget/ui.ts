import { WIDGET_CSS } from './styles';
import type { WidgetTheme } from './types';

export type BubbleState = 'sending' | 'sent' | 'failed';

/** Handle for one optimistically rendered outgoing message bubble. */
export interface BubbleHandle {
  setState(state: BubbleState): void;
}

export interface WidgetUiCallbacks {
  onSend(content: string): void;
  /** Returns a German error text, or null on success (the prompt then closes). */
  onContactSave(name: string, email: string): Promise<string | null>;
  onContactSkip(): void;
}

export interface WidgetUi {
  open(): void;
  close(): void;
  isOpen(): boolean;
  setOffline(visible: boolean): void;
  addAgentMessage(content: string, options?: { notify?: boolean }): void;
  addContactMessage(content: string): BubbleHandle;
  /** Clears the message list and re-renders the greeting bubble. */
  resetMessages(): void;
  showContactPrompt(): void;
  hideContactPrompt(): void;
}

/**
 * Static markup only — every dynamic value (title, greeting, messages) is set
 * via textContent, never via innerHTML, so message content can not inject DOM.
 */
const TEMPLATE = `
<div class="zw-root">
  <button class="zw-bubble" type="button" aria-label="Chat öffnen" aria-haspopup="dialog" aria-expanded="false">
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/>
    </svg>
    <span class="zw-unread" aria-hidden="true" hidden></span>
  </button>
  <div class="zw-panel" role="dialog" hidden>
    <header class="zw-header">
      <span class="zw-title"></span>
      <button class="zw-close" type="button" aria-label="Chat schließen">&#215;</button>
    </header>
    <div class="zw-banner" role="status" hidden>Keine Verbindung — wir versuchen es erneut …</div>
    <div class="zw-messages" aria-live="polite"></div>
    <div class="zw-contact" hidden>
      <p class="zw-contact-hint">Damit wir antworten können: Name und E-Mail (optional)</p>
      <div class="zw-contact-fields">
        <input class="zw-contact-name" type="text" placeholder="Name" aria-label="Name" maxlength="200" autocomplete="name" />
        <input class="zw-contact-email" type="email" placeholder="E-Mail-Adresse" aria-label="E-Mail-Adresse" maxlength="200" autocomplete="email" />
      </div>
      <p class="zw-contact-error" role="alert" hidden></p>
      <div class="zw-contact-actions">
        <button class="zw-contact-save" type="button">Speichern</button>
        <button class="zw-contact-skip" type="button">Später</button>
      </div>
    </div>
    <form class="zw-composer">
      <textarea class="zw-input" rows="1" placeholder="Nachricht schreiben …" aria-label="Nachricht schreiben" maxlength="4000"></textarea>
      <button class="zw-send" type="submit" aria-label="Senden">Senden</button>
    </form>
  </div>
</div>
`;

const COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const DEFAULT_COLOR = '#4f46e5';

const STATUS_META: Record<BubbleState, { text: string; hint: string }> = {
  sending: { text: '…', hint: 'Wird gesendet' },
  sent: { text: '✓', hint: 'Gesendet' },
  failed: { text: 'Nicht gesendet', hint: 'Nicht gesendet' },
};

function q<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Widget element missing: ${selector}`);
  return element;
}

export function createWidgetUi(
  shadow: ShadowRoot,
  theme: WidgetTheme,
  callbacks: WidgetUiCallbacks
): WidgetUi {
  const style = document.createElement('style');
  style.textContent = WIDGET_CSS;
  shadow.appendChild(style);

  const holder = document.createElement('div');
  holder.innerHTML = TEMPLATE;
  const root = q<HTMLDivElement>(holder, '.zw-root');
  shadow.appendChild(root);

  root.style.setProperty(
    '--zw-color',
    COLOR_PATTERN.test(theme.color) ? theme.color : DEFAULT_COLOR
  );

  const bubble = q<HTMLButtonElement>(root, '.zw-bubble');
  const unreadBadge = q<HTMLSpanElement>(root, '.zw-unread');
  const panel = q<HTMLDivElement>(root, '.zw-panel');
  const title = q<HTMLSpanElement>(root, '.zw-title');
  const closeButton = q<HTMLButtonElement>(root, '.zw-close');
  const banner = q<HTMLDivElement>(root, '.zw-banner');
  const messages = q<HTMLDivElement>(root, '.zw-messages');
  const contactBlock = q<HTMLDivElement>(root, '.zw-contact');
  const contactName = q<HTMLInputElement>(root, '.zw-contact-name');
  const contactEmail = q<HTMLInputElement>(root, '.zw-contact-email');
  const contactError = q<HTMLParagraphElement>(root, '.zw-contact-error');
  const contactSave = q<HTMLButtonElement>(root, '.zw-contact-save');
  const contactSkip = q<HTMLButtonElement>(root, '.zw-contact-skip');
  const composer = q<HTMLFormElement>(root, '.zw-composer');
  const input = q<HTMLTextAreaElement>(root, '.zw-input');

  title.textContent = theme.title;
  panel.setAttribute('aria-label', theme.title);

  let unreadCount = 0;

  function scrollToBottom(): void {
    messages.scrollTop = messages.scrollHeight;
  }

  function renderGreeting(): void {
    if (!theme.greeting) return;
    const el = document.createElement('div');
    el.className = 'zw-msg zw-msg-in';
    el.textContent = theme.greeting;
    messages.appendChild(el);
  }

  function updateUnreadBadge(): void {
    if (unreadCount > 0) {
      unreadBadge.hidden = false;
      unreadBadge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
    } else {
      unreadBadge.hidden = true;
      unreadBadge.textContent = '';
    }
  }

  function isOpen(): boolean {
    return !panel.hidden;
  }

  function open(): void {
    panel.hidden = false;
    bubble.setAttribute('aria-expanded', 'true');
    bubble.setAttribute('aria-label', 'Chat schließen');
    unreadCount = 0;
    updateUnreadBadge();
    scrollToBottom();
    input.focus();
  }

  function close(): void {
    panel.hidden = true;
    bubble.setAttribute('aria-expanded', 'false');
    bubble.setAttribute('aria-label', 'Chat öffnen');
    bubble.focus();
  }

  function autoResizeInput(): void {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }

  async function handleContactSave(): Promise<void> {
    contactSave.disabled = true;
    contactSkip.disabled = true;
    contactError.hidden = true;
    try {
      const error = await callbacks.onContactSave(contactName.value, contactEmail.value);
      if (error) {
        contactError.textContent = error;
        contactError.hidden = false;
      } else {
        contactBlock.hidden = true;
      }
    } finally {
      contactSave.disabled = false;
      contactSkip.disabled = false;
    }
  }

  bubble.addEventListener('click', () => {
    if (isOpen()) close();
    else open();
  });
  closeButton.addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  input.addEventListener('input', autoResizeInput);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content) return;
    input.value = '';
    autoResizeInput();
    callbacks.onSend(content);
    input.focus();
  });

  contactSkip.addEventListener('click', () => {
    callbacks.onContactSkip();
    contactBlock.hidden = true;
    input.focus();
  });
  contactSave.addEventListener('click', () => {
    void handleContactSave();
  });

  renderGreeting();

  return {
    open,
    close,
    isOpen,
    setOffline(visible: boolean): void {
      banner.hidden = !visible;
    },
    addAgentMessage(content: string, options?: { notify?: boolean }): void {
      const el = document.createElement('div');
      el.className = 'zw-msg zw-msg-in';
      el.textContent = content;
      messages.appendChild(el);
      scrollToBottom();
      if (options?.notify !== false && !isOpen()) {
        unreadCount += 1;
        updateUnreadBadge();
      }
    },
    addContactMessage(content: string): BubbleHandle {
      const wrap = document.createElement('div');
      wrap.className = 'zw-out-wrap';
      const messageEl = document.createElement('div');
      messageEl.className = 'zw-msg zw-msg-out';
      messageEl.textContent = content;
      const statusEl = document.createElement('div');
      statusEl.className = 'zw-status';
      wrap.appendChild(messageEl);
      wrap.appendChild(statusEl);
      messages.appendChild(wrap);
      scrollToBottom();
      const handle: BubbleHandle = {
        setState(state: BubbleState): void {
          const meta = STATUS_META[state];
          statusEl.textContent = meta.text;
          statusEl.title = meta.hint;
          statusEl.classList.toggle('zw-status-failed', state === 'failed');
        },
      };
      handle.setState('sending');
      return handle;
    },
    resetMessages(): void {
      messages.textContent = '';
      renderGreeting();
    },
    showContactPrompt(): void {
      contactBlock.hidden = false;
    },
    hideContactPrompt(): void {
      contactBlock.hidden = true;
    },
  };
}
