import {
  accentBackground,
  onAccentColor,
  widgetFontStack,
  widgetInitials,
  type WidgetLauncherIcon,
  type WidgetTheme,
} from '@zendori/channels/chat-theme';
import { WIDGET_CSS } from './styles';

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
  /** The visitor closed the teaser bubble (do not show it again this visit). */
  onTeaserDismiss?(): void;
}

export interface WidgetUiOptions {
  /**
   * Designer preview: launcher and panel are positioned inside the host's
   * container instead of the viewport, and nothing takes the keyboard focus.
   */
  preview?: boolean;
}

export interface WidgetUi {
  open(): void;
  close(): void;
  isOpen(): boolean;
  setOffline(visible: boolean): void;
  /** `at` = when the message was written (ISO); shown as a small time below. */
  addAgentMessage(content: string, options?: { notify?: boolean; at?: string }): void;
  /**
   * Appends an image the bot sent along with its reply (0025). `url` is a
   * short-lived signed Storage URL from our own attachment endpoint.
   */
  addAgentImage(url: string, alt: string): void;
  addContactMessage(content: string, at?: string): BubbleHandle;
  /** Clears the message list and re-renders the greeting (and its quick replies). */
  resetMessages(): void;
  showContactPrompt(): void;
  hideContactPrompt(): void;
  /** Shows the animated "…" bubble below the newest message (idempotent). */
  showTyping(): void;
  hideTyping(): void;
  /** Shows the small invitation next to the launcher (no-op without teaser text or when open). */
  showTeaser(): void;
}

/**
 * Static markup only — every dynamic value (title, greeting, messages, theme
 * texts) is set via textContent, never via innerHTML, so neither message
 * content nor a theme can inject DOM. Icons are built with createElementNS
 * from the constant path data below.
 */
const TEMPLATE = `
<div class="zw-root">
  <div class="zw-teaser" hidden>
    <button class="zw-teaser-text" type="button"></button>
    <button class="zw-teaser-close" type="button" aria-label="Hinweis schließen"></button>
  </div>
  <button class="zw-launcher" type="button" aria-label="Chat öffnen" aria-haspopup="dialog" aria-expanded="false">
    <span class="zw-launcher-icons" aria-hidden="true"></span>
    <span class="zw-launcher-label"></span>
    <span class="zw-unread" aria-hidden="true" hidden></span>
  </button>
  <div class="zw-panel" role="dialog" hidden>
    <header class="zw-header">
      <span class="zw-avatar" aria-hidden="true" hidden></span>
      <span class="zw-heading">
        <span class="zw-title"></span>
        <span class="zw-subtitle" hidden><i class="zw-online" aria-hidden="true"></i><span></span></span>
      </span>
      <button class="zw-close" type="button" aria-label="Chat schließen"></button>
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
      <div class="zw-field">
        <textarea class="zw-input" rows="1" aria-label="Nachricht schreiben" maxlength="4000"></textarea>
        <button class="zw-send zw-send-idle" type="submit" aria-label="Senden"></button>
      </div>
    </form>
    <a class="zw-brand" href="https://zendori.ai" target="_blank" rel="noopener" hidden>Bereitgestellt von <b>Zendori</b></a>
  </div>
</div>
`;

/** Stroke icons on a 24 grid — constant path data, never theme or message content. */
const LAUNCHER_ICONS: Record<WidgetLauncherIcon, string[]> = {
  chat: ['M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  message: [
    'M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z',
    'M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1',
  ],
  question: [
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
    'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3',
    'M12 17h.01',
  ],
  spark: [
    'M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6-5.6-1.9 5.6-1.9L12 3z',
    'M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z',
  ],
  headset: [
    'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3',
  ],
};
const ICON_CLOSE = ['M18 6 6 18', 'M6 6l12 12'];
const ICON_MINIMIZE = ['m6 9 6 6 6-6'];
const ICON_SEND = ['M12 19V5', 'M5 12l7-7 7 7'];

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgIcon(paths: string[], className?: string, strokeWidth = 2): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

const FONT_SIZE_PX: Record<WidgetTheme['fontSize'], string> = { sm: '13.5px', md: '14.5px', lg: '16px' };
const RADII: Record<
  WidgetTheme['radius'],
  { panel: string; bubble: string; field: string; pill: string }
> = {
  sharp: { panel: '8px', bubble: '6px', field: '6px', pill: '8px' },
  soft: { panel: '20px', bubble: '18px', field: '14px', pill: '999px' },
  round: { panel: '28px', bubble: '22px', field: '999px', pill: '999px' },
};

const STATUS_META: Record<BubbleState, { text: string; hint: string }> = {
  sending: { text: 'Wird gesendet …', hint: 'Wird gesendet' },
  sent: { text: '✓', hint: 'Gesendet' },
  failed: { text: 'Nicht gesendet', hint: 'Nicht gesendet' },
};

const timeFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

/** "14:05" for an ISO timestamp (now when absent or unparsable). */
function formatTime(at?: string): string {
  const date = at ? new Date(at) : new Date();
  return timeFormat.format(Number.isNaN(date.getTime()) ? new Date() : date);
}

function q<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Widget element missing: ${selector}`);
  return element;
}

/** Writes the theme onto the root: custom properties + modifier classes. */
function applyTheme(root: HTMLElement, theme: WidgetTheme, preview: boolean): void {
  const radii = RADII[theme.radius];
  root.style.setProperty('--zw-accent', theme.color);
  root.style.setProperty('--zw-accent-bg', accentBackground(theme));
  root.style.setProperty('--zw-on-accent', onAccentColor(theme));
  root.style.setProperty('--zw-font', widgetFontStack(theme));
  root.style.setProperty('--zw-fs', FONT_SIZE_PX[theme.fontSize]);
  root.style.setProperty('--zw-r-panel', radii.panel);
  root.style.setProperty('--zw-r-bubble', radii.bubble);
  root.style.setProperty('--zw-r-field', radii.field);
  root.style.setProperty('--zw-r-pill', radii.pill);
  root.style.setProperty('--zw-x', `${theme.offsetX}px`);
  root.style.setProperty('--zw-y', `${theme.offsetY}px`);
  root.classList.toggle('zw-left', theme.position === 'left');
  root.classList.toggle('zw-scheme-dark', theme.scheme === 'dark');
  root.classList.toggle('zw-scheme-auto', theme.scheme === 'auto');
  root.classList.toggle('zw-has-label', theme.launcher === 'label');
  root.classList.toggle('zw-preview', preview);
}

export function createWidgetUi(
  shadow: ShadowRoot,
  theme: WidgetTheme,
  callbacks: WidgetUiCallbacks,
  options: WidgetUiOptions = {}
): WidgetUi {
  const preview = options.preview === true;
  const style = document.createElement('style');
  style.textContent = WIDGET_CSS;
  shadow.appendChild(style);

  const holder = document.createElement('div');
  holder.innerHTML = TEMPLATE;
  const root = q<HTMLDivElement>(holder, '.zw-root');
  shadow.appendChild(root);
  applyTheme(root, theme, preview);

  const launcher = q<HTMLButtonElement>(root, '.zw-launcher');
  const launcherIcons = q<HTMLSpanElement>(root, '.zw-launcher-icons');
  const launcherLabel = q<HTMLSpanElement>(root, '.zw-launcher-label');
  const unreadBadge = q<HTMLSpanElement>(root, '.zw-unread');
  const teaser = q<HTMLDivElement>(root, '.zw-teaser');
  const teaserText = q<HTMLButtonElement>(root, '.zw-teaser-text');
  const teaserClose = q<HTMLButtonElement>(root, '.zw-teaser-close');
  const panel = q<HTMLDivElement>(root, '.zw-panel');
  const avatar = q<HTMLSpanElement>(root, '.zw-avatar');
  const title = q<HTMLSpanElement>(root, '.zw-title');
  const subtitle = q<HTMLSpanElement>(root, '.zw-subtitle');
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
  const sendButton = q<HTMLButtonElement>(root, '.zw-send');
  const brand = q<HTMLAnchorElement>(root, '.zw-brand');

  // --- static parts filled from the theme ----------------------------------------
  launcherIcons.append(
    svgIcon(LAUNCHER_ICONS[theme.launcherIcon], 'zw-ico-open'),
    svgIcon(ICON_CLOSE, 'zw-ico-close', 2.2)
  );
  launcherLabel.textContent = theme.launcherLabel;
  teaserText.textContent = theme.teaserText;
  teaserClose.appendChild(svgIcon(ICON_CLOSE, undefined, 2.2));
  q<SVGSVGElement>(teaserClose, 'svg').setAttribute('width', '13');
  q<SVGSVGElement>(teaserClose, 'svg').setAttribute('height', '13');
  closeButton.appendChild(svgIcon(ICON_MINIMIZE, undefined, 2.2));
  sendButton.appendChild(svgIcon(ICON_SEND, undefined, 2.4));
  title.textContent = theme.title;
  panel.setAttribute('aria-label', theme.title);
  if (theme.subtitle) {
    q<HTMLSpanElement>(subtitle, 'span').textContent = theme.subtitle;
    subtitle.hidden = false;
  }
  input.placeholder = theme.placeholder;
  brand.hidden = !theme.branding;

  function renderAvatar(): void {
    avatar.textContent = '';
    if (theme.avatar === 'none') {
      avatar.hidden = true;
      return;
    }
    avatar.hidden = false;
    const fallback = (): void => {
      avatar.textContent = '';
      avatar.appendChild(svgIcon(LAUNCHER_ICONS[theme.launcherIcon]));
    };
    if (theme.avatar === 'initials') {
      avatar.textContent = widgetInitials(theme.title);
    } else if (theme.avatar === 'image' && theme.avatarUrl) {
      // Built with createElement; the URL is https-only and sanitized by
      // normalizeWidgetTheme. A broken image falls back to the icon.
      const img = document.createElement('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', fallback, { once: true });
      img.src = theme.avatarUrl;
      avatar.appendChild(img);
    } else {
      fallback();
    }
  }
  renderAvatar();

  let unreadCount = 0;
  let typingEl: HTMLDivElement | null = null;
  let chipsEl: HTMLDivElement | null = null;

  function scrollToBottom(): void {
    messages.scrollTop = messages.scrollHeight;
  }

  /** The quick replies belong to the untouched greeting — any real message removes them. */
  function removeChips(): void {
    if (chipsEl) {
      chipsEl.remove();
      chipsEl = null;
    }
  }

  function item(direction: 'in' | 'out'): { wrap: HTMLDivElement; meta: HTMLDivElement } {
    const wrap = document.createElement('div');
    wrap.className = `zw-item zw-item-${direction}`;
    const meta = document.createElement('div');
    meta.className = 'zw-meta';
    return { wrap, meta };
  }

  function showTyping(): void {
    if (!typingEl) {
      typingEl = document.createElement('div');
      typingEl.className = 'zw-item zw-item-in';
      const dots = document.createElement('div');
      dots.className = 'zw-msg zw-msg-in zw-typing';
      dots.setAttribute('role', 'status');
      dots.setAttribute('aria-label', 'Antwort wird geschrieben');
      for (let i = 0; i < 3; i += 1) {
        const dot = document.createElement('span');
        dot.className = 'zw-typing-dot';
        dot.setAttribute('aria-hidden', 'true');
        dots.appendChild(dot);
      }
      typingEl.appendChild(dots);
    }
    // (re-)append so the indicator always sits below the newest message
    messages.appendChild(typingEl);
    scrollToBottom();
  }

  function hideTyping(): void {
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  }

  function sendFromUi(content: string): void {
    callbacks.onSend(content);
    if (!preview) input.focus();
  }

  function renderGreeting(): void {
    if (theme.greeting) {
      const { wrap } = item('in');
      const bubble = document.createElement('div');
      bubble.className = 'zw-msg zw-msg-in';
      bubble.textContent = theme.greeting;
      wrap.appendChild(bubble);
      messages.appendChild(wrap);
    }
    if (theme.quickReplies.length > 0) {
      chipsEl = document.createElement('div');
      chipsEl.className = 'zw-chips';
      for (const reply of theme.quickReplies) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'zw-chip';
        chip.textContent = reply;
        chip.addEventListener('click', () => sendFromUi(reply));
        chipsEl.appendChild(chip);
      }
      messages.appendChild(chipsEl);
    }
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

  function updateSendState(): void {
    sendButton.classList.toggle('zw-send-idle', input.value.trim().length === 0);
  }

  function isOpen(): boolean {
    return !panel.hidden;
  }

  function open(): void {
    panel.hidden = false;
    teaser.hidden = true;
    root.classList.add('zw-open');
    launcher.setAttribute('aria-expanded', 'true');
    launcher.setAttribute('aria-label', 'Chat schließen');
    unreadCount = 0;
    updateUnreadBadge();
    scrollToBottom();
    if (!preview) input.focus();
  }

  function close(): void {
    panel.hidden = true;
    root.classList.remove('zw-open');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', 'Chat öffnen');
    if (!preview) launcher.focus();
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

  launcher.addEventListener('click', () => {
    if (isOpen()) close();
    else open();
  });
  closeButton.addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  teaserText.addEventListener('click', open);
  teaserClose.addEventListener('click', () => {
    teaser.hidden = true;
    callbacks.onTeaserDismiss?.();
  });

  input.addEventListener('input', () => {
    autoResizeInput();
    updateSendState();
  });
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
    updateSendState();
    sendFromUi(content);
  });

  contactSkip.addEventListener('click', () => {
    callbacks.onContactSkip();
    contactBlock.hidden = true;
    if (!preview) input.focus();
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
    addAgentMessage(content: string, messageOptions?: { notify?: boolean; at?: string }): void {
      hideTyping(); // the reply replaces the dots
      removeChips();
      const { wrap, meta } = item('in');
      const bubble = document.createElement('div');
      bubble.className = 'zw-msg zw-msg-in';
      bubble.textContent = content;
      meta.textContent = formatTime(messageOptions?.at);
      wrap.append(bubble, meta);
      messages.appendChild(wrap);
      scrollToBottom();
      if (messageOptions?.notify !== false && !isOpen()) {
        unreadCount += 1;
        updateUnreadBadge();
      }
    },
    // The one deliberate exception to "no dynamic DOM beyond textContent": an
    // <img> element. It is still built with createElement, never innerHTML, and
    // the src comes ONLY from our own JSON response — never parsed out of
    // message text — so nothing a customer or a knowledge-base file contains can
    // steer it. The endpoint additionally only ever returns raster image types.
    addAgentImage(url: string, alt: string): void {
      hideTyping();
      const { wrap } = item('in');
      const bubble = document.createElement('div');
      bubble.className = 'zw-msg zw-msg-in zw-msg-img';
      const img = document.createElement('img');
      img.src = url;
      img.alt = alt;
      img.loading = 'lazy';
      bubble.appendChild(img);
      wrap.appendChild(bubble);
      messages.appendChild(wrap);
      if (typingEl) messages.appendChild(typingEl);
      scrollToBottom();
    },
    addContactMessage(content: string, at?: string): BubbleHandle {
      removeChips();
      const { wrap, meta } = item('out');
      const bubble = document.createElement('div');
      bubble.className = 'zw-msg zw-msg-out';
      bubble.textContent = content;
      const time = document.createElement('span');
      time.textContent = formatTime(at);
      const status = document.createElement('span');
      meta.append(time, status);
      wrap.append(bubble, meta);
      messages.appendChild(wrap);
      if (typingEl) messages.appendChild(typingEl); // keep the dots below the newest message
      scrollToBottom();
      const handle: BubbleHandle = {
        setState(state: BubbleState): void {
          const info = STATUS_META[state];
          status.textContent = info.text;
          status.title = info.hint;
          status.classList.toggle('zw-status-failed', state === 'failed');
          // while sending or failed the status says more than the clock
          time.hidden = state !== 'sent';
        },
      };
      handle.setState('sending');
      return handle;
    },
    resetMessages(): void {
      typingEl = null; // elements are removed with the rest of the list below
      chipsEl = null;
      messages.textContent = '';
      renderGreeting();
    },
    showContactPrompt(): void {
      contactBlock.hidden = false;
    },
    hideContactPrompt(): void {
      contactBlock.hidden = true;
    },
    showTyping,
    hideTyping,
    showTeaser(): void {
      if (!theme.teaser || !theme.teaserText || isOpen()) return;
      teaser.hidden = false;
    },
  };
}
