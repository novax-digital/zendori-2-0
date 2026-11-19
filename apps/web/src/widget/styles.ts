/**
 * All widget styles live inline in the shadow root — no external stylesheet,
 * no CSS framework. The look is driven by custom properties that ui.ts sets on
 * .zw-root from the channel theme (packages/channels chat/theme.ts):
 *   --zw-accent      main color (focus rings, chips, links)
 *   --zw-accent-bg   accent surface: the color or a gradient (launcher, header, own messages)
 *   --zw-on-accent   text on the accent surface (white or near-black by contrast)
 *   --zw-font        font-family
 *   --zw-fs          base font size
 *   --zw-r-panel / --zw-r-bubble / --zw-r-field / --zw-r-pill   corner radii (pill = launcher, chips, buttons)
 *   --zw-x / --zw-y  distance of the launcher from the side / bottom edge
 * Modifier classes on .zw-root: zw-left (left corner), zw-scheme-dark,
 * zw-scheme-auto (follows prefers-color-scheme), zw-has-label (text launcher),
 * zw-open (panel shown), zw-preview (designer preview: positioned inside its
 * container instead of the viewport).
 */
export const WIDGET_CSS = `
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

.zw-root {
  --zw-accent: #4f46e5;
  --zw-accent-bg: var(--zw-accent);
  --zw-on-accent: #ffffff;
  --zw-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --zw-fs: 14.5px;
  --zw-r-panel: 20px;
  --zw-r-bubble: 18px;
  --zw-r-field: 14px;
  --zw-r-pill: 999px;
  --zw-x: 20px;
  --zw-y: 20px;

  /* light scheme */
  --zw-bg: #ffffff;
  --zw-canvas: #f5f7fa;
  --zw-text: #0f172a;
  --zw-muted: #64748b;
  --zw-line: #e5e9ef;
  --zw-in: #ffffff;
  --zw-field: #f3f5f8;
  --zw-shadow: 0 24px 60px -18px rgba(15, 23, 42, 0.35), 0 8px 20px -10px rgba(15, 23, 42, 0.2);

  font-family: var(--zw-font);
  font-size: var(--zw-fs);
  line-height: 1.45;
  color: var(--zw-text);
  -webkit-font-smoothing: antialiased;
  text-align: left;
}

.zw-root.zw-scheme-dark {
  --zw-bg: #111827;
  --zw-canvas: #0b1220;
  --zw-text: #e5e7eb;
  --zw-muted: #94a3b8;
  --zw-line: #243044;
  --zw-in: #1c2536;
  --zw-field: #1c2536;
  --zw-shadow: 0 24px 60px -18px rgba(0, 0, 0, 0.7), 0 8px 20px -10px rgba(0, 0, 0, 0.5);
}

@media (prefers-color-scheme: dark) {
  .zw-root.zw-scheme-auto {
    --zw-bg: #111827;
    --zw-canvas: #0b1220;
    --zw-text: #e5e7eb;
    --zw-muted: #94a3b8;
    --zw-line: #243044;
    --zw-in: #1c2536;
    --zw-field: #1c2536;
    --zw-shadow: 0 24px 60px -18px rgba(0, 0, 0, 0.7), 0 8px 20px -10px rgba(0, 0, 0, 0.5);
  }
}

.zw-root button {
  font-family: inherit;
}

.zw-root svg {
  display: block;
  flex-shrink: 0;
}

/* ---- launcher -------------------------------------------------------------- */

.zw-launcher {
  position: fixed;
  right: var(--zw-x);
  bottom: var(--zw-y);
  z-index: 2147483000;
  height: 60px;
  min-width: 60px;
  padding: 0;
  border: none;
  border-radius: var(--zw-r-pill);
  background: var(--zw-accent-bg);
  color: var(--zw-on-accent);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 15px;
  font-weight: 600;
  box-shadow:
    0 14px 30px -10px color-mix(in srgb, var(--zw-accent) 60%, transparent),
    0 4px 12px rgba(15, 23, 42, 0.18);
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease,
    padding 0.18s ease;
}

.zw-left .zw-launcher {
  right: auto;
  left: var(--zw-x);
}

.zw-launcher:hover {
  transform: translateY(-2px) scale(1.03);
  box-shadow:
    0 18px 36px -10px color-mix(in srgb, var(--zw-accent) 70%, transparent),
    0 6px 14px rgba(15, 23, 42, 0.2);
}

.zw-launcher:active {
  transform: scale(0.97);
}

.zw-launcher:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--zw-accent) 45%, #ffffff);
  outline-offset: 3px;
}

/* the two icons sit on top of each other and cross-fade */
.zw-launcher-icons {
  position: relative;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
}

.zw-launcher-icons svg {
  position: absolute;
  inset: 0;
  width: 26px;
  height: 26px;
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.zw-ico-close {
  opacity: 0;
  transform: rotate(-60deg) scale(0.6);
}

.zw-open .zw-ico-open {
  opacity: 0;
  transform: rotate(60deg) scale(0.6);
}

.zw-open .zw-ico-close {
  opacity: 1;
  transform: none;
}

.zw-launcher-label {
  display: none;
  white-space: nowrap;
}

.zw-has-label:not(.zw-open) .zw-launcher {
  padding: 0 22px 0 18px;
}

.zw-has-label:not(.zw-open) .zw-launcher-label {
  display: inline;
}

.zw-unread {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 10px;
  background: #ef4444;
  border: 2px solid #ffffff;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.zw-unread[hidden] {
  display: none;
}

/* ---- teaser ---------------------------------------------------------------- */

.zw-teaser {
  position: fixed;
  right: var(--zw-x);
  bottom: calc(var(--zw-y) + 74px);
  z-index: 2147483000;
  max-width: 260px;
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 4px 4px 4px 0;
  background: var(--zw-bg);
  color: var(--zw-text);
  border: 1px solid var(--zw-line);
  border-radius: 16px;
  border-bottom-right-radius: 5px;
  box-shadow: 0 14px 34px -14px rgba(15, 23, 42, 0.35);
  animation: zw-rise 0.28s ease both;
}

.zw-left .zw-teaser {
  right: auto;
  left: var(--zw-x);
  border-bottom-right-radius: 16px;
  border-bottom-left-radius: 5px;
}

.zw-teaser[hidden],
.zw-open .zw-teaser {
  display: none;
}

.zw-teaser-text {
  background: none;
  border: none;
  color: inherit;
  font-size: 14px;
  line-height: 1.4;
  text-align: left;
  padding: 8px 4px 8px 14px;
  cursor: pointer;
}

.zw-teaser-close {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--zw-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.zw-teaser-close:hover {
  background: var(--zw-field);
  color: var(--zw-text);
}

.zw-teaser-text:focus-visible,
.zw-teaser-close:focus-visible {
  outline: 2px solid var(--zw-accent);
  outline-offset: 1px;
  border-radius: 8px;
}

/* ---- panel ----------------------------------------------------------------- */

.zw-panel {
  position: fixed;
  right: var(--zw-x);
  bottom: calc(var(--zw-y) + 76px);
  z-index: 2147483000;
  width: 384px;
  max-width: calc(100vw - 2 * var(--zw-x));
  height: 640px;
  max-height: calc(100vh - var(--zw-y) - 96px);
  background: var(--zw-bg);
  border: 1px solid var(--zw-line);
  border-radius: var(--zw-r-panel);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: var(--zw-shadow);
  transform-origin: bottom right;
  animation: zw-panel-in 0.24s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

.zw-left .zw-panel {
  right: auto;
  left: var(--zw-x);
  transform-origin: bottom left;
}

.zw-panel[hidden] {
  display: none;
}

@keyframes zw-panel-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes zw-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ---- header ---------------------------------------------------------------- */

.zw-header {
  position: relative;
  background: var(--zw-accent-bg);
  color: var(--zw-on-accent);
  padding: 16px 14px 16px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  overflow: hidden;
}

/* soft highlight for depth — purely decorative */
.zw-header::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(120% 140% at 100% 0%, rgba(255, 255, 255, 0.22), transparent 55%);
  pointer-events: none;
}

.zw-avatar {
  position: relative;
  z-index: 1;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--zw-on-accent) 18%, transparent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.02em;
  flex-shrink: 0;
  overflow: hidden;
}

.zw-avatar[hidden] {
  display: none;
}

.zw-avatar svg {
  width: 21px;
  height: 21px;
}

.zw-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #ffffff;
}

.zw-heading {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.zw-title {
  font-weight: 600;
  font-size: 16px;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zw-subtitle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  opacity: 0.88;
  min-width: 0;
}

.zw-subtitle[hidden] {
  display: none;
}

.zw-subtitle span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zw-online {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 0 2px color-mix(in srgb, #34d399 35%, transparent);
  flex-shrink: 0;
}

.zw-close {
  position: relative;
  z-index: 1;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background-color 0.15s ease;
}

.zw-close:hover {
  background: color-mix(in srgb, var(--zw-on-accent) 18%, transparent);
}

.zw-close:focus-visible {
  outline: 2px solid var(--zw-on-accent);
  outline-offset: 1px;
}

.zw-banner {
  background: #fef3c7;
  color: #92400e;
  font-size: 12.5px;
  padding: 7px 12px;
  text-align: center;
  flex-shrink: 0;
}

.zw-banner[hidden] {
  display: none;
}

/* ---- messages -------------------------------------------------------------- */

.zw-messages {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--zw-canvas);
  scrollbar-width: thin;
  scrollbar-color: var(--zw-line) transparent;
}

.zw-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-width: 84%;
  animation: zw-rise 0.2s ease both;
}

.zw-item-in {
  align-self: flex-start;
  align-items: flex-start;
}

.zw-item-out {
  align-self: flex-end;
  align-items: flex-end;
}

.zw-msg {
  max-width: 100%;
  padding: 9px 13px;
  border-radius: var(--zw-r-bubble);
  font-size: 1em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.zw-msg-in {
  background: var(--zw-in);
  border: 1px solid var(--zw-line);
  border-bottom-left-radius: min(6px, var(--zw-r-bubble));
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.zw-msg-out {
  background: var(--zw-accent-bg);
  color: var(--zw-on-accent);
  border-bottom-right-radius: min(6px, var(--zw-r-bubble));
}

/* Image bubble (0025): no text padding, the picture is the content. */
.zw-msg-img {
  padding: 4px;
}

.zw-msg-img img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: calc(var(--zw-r-bubble) - 4px);
}

.zw-meta {
  font-size: 11px;
  color: var(--zw-muted);
  padding: 0 4px;
  display: flex;
  gap: 5px;
  align-items: center;
}

.zw-meta:empty {
  display: none;
}

.zw-status-failed {
  color: #dc2626;
}

/* suggested first messages below the greeting */
.zw-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 2px;
  animation: zw-rise 0.24s ease 0.08s both;
}

.zw-chip {
  background: var(--zw-bg);
  border: 1px solid color-mix(in srgb, var(--zw-accent) 45%, var(--zw-line));
  color: var(--zw-text);
  border-radius: var(--zw-r-pill);
  padding: 7px 13px;
  font-size: 0.93em;
  font-weight: 500;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    transform 0.15s ease;
}

.zw-chip:hover {
  background: color-mix(in srgb, var(--zw-accent) 12%, var(--zw-bg));
  border-color: var(--zw-accent);
  transform: translateY(-1px);
}

.zw-chip:focus-visible {
  outline: 2px solid var(--zw-accent);
  outline-offset: 2px;
}

.zw-typing {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 13px 15px;
}

.zw-typing-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--zw-muted);
  animation: zw-typing-pulse 1.2s ease-in-out infinite;
}

.zw-typing-dot:nth-child(2) {
  animation-delay: 0.2s;
}

.zw-typing-dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes zw-typing-pulse {
  0%,
  60%,
  100% {
    opacity: 0.35;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-3px);
  }
}

/* ---- contact prompt -------------------------------------------------------- */

.zw-contact {
  border-top: 1px solid var(--zw-line);
  background: var(--zw-bg);
  padding: 12px 14px;
  flex-shrink: 0;
}

.zw-contact[hidden] {
  display: none;
}

.zw-contact-hint {
  font-size: 12.5px;
  color: var(--zw-muted);
  margin-bottom: 8px;
}

.zw-contact-fields {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.zw-contact-fields input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--zw-line);
  border-radius: min(10px, var(--zw-r-field));
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  background: var(--zw-field);
  color: inherit;
  outline: none;
}

.zw-contact-fields input::placeholder {
  color: var(--zw-muted);
}

.zw-contact-fields input:focus-visible {
  border-color: var(--zw-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--zw-accent) 20%, transparent);
}

.zw-contact-error {
  font-size: 12px;
  color: #dc2626;
  margin-bottom: 8px;
}

.zw-contact-error[hidden] {
  display: none;
}

.zw-contact-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.zw-contact-save {
  background: var(--zw-accent-bg);
  color: var(--zw-on-accent);
  border: none;
  border-radius: var(--zw-r-pill);
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.zw-contact-save:focus-visible,
.zw-contact-skip:focus-visible,
.zw-send:focus-visible {
  outline: 2px solid var(--zw-accent);
  outline-offset: 2px;
}

.zw-contact-save:disabled,
.zw-contact-skip:disabled {
  opacity: 0.6;
  cursor: default;
}

.zw-contact-skip {
  background: none;
  border: none;
  color: var(--zw-muted);
  font-size: 13px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
  padding: 6px 2px;
}

/* ---- composer -------------------------------------------------------------- */

.zw-composer {
  border-top: 1px solid var(--zw-line);
  padding: 10px 12px;
  background: var(--zw-bg);
  flex-shrink: 0;
}

.zw-field {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 5px 5px 5px 4px;
  background: var(--zw-field);
  border: 1px solid transparent;
  border-radius: var(--zw-r-field);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    background-color 0.15s ease;
}

.zw-field:focus-within {
  background: var(--zw-bg);
  border-color: var(--zw-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--zw-accent) 18%, transparent);
}

.zw-input {
  flex: 1;
  min-width: 0;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  padding: 7px 8px;
  font: inherit;
  font-size: 1em;
  line-height: 1.4;
  max-height: 120px;
  color: inherit;
}

.zw-input::placeholder {
  color: var(--zw-muted);
}

.zw-send {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: min(999px, calc(var(--zw-r-field) - 2px));
  background: var(--zw-accent-bg);
  color: var(--zw-on-accent);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.zw-send svg {
  width: 18px;
  height: 18px;
}

.zw-send:hover {
  transform: translateY(-1px);
}

/* nothing typed yet */
.zw-send.zw-send-idle {
  opacity: 0.45;
}

.zw-brand {
  display: block;
  text-align: center;
  font-size: 11px;
  color: var(--zw-muted);
  text-decoration: none;
  padding: 0 12px 9px;
  background: var(--zw-bg);
  flex-shrink: 0;
}

.zw-brand[hidden] {
  display: none;
}

.zw-brand b {
  font-weight: 600;
  color: var(--zw-text);
}

.zw-brand:hover b {
  text-decoration: underline;
}

/* ---- designer preview: inside its container, not the viewport ---------------- */

.zw-preview .zw-launcher,
.zw-preview .zw-panel,
.zw-preview .zw-teaser {
  position: absolute;
  z-index: 1;
}

.zw-preview .zw-panel {
  max-width: calc(100% - 2 * var(--zw-x));
  max-height: calc(100% - var(--zw-y) - 96px);
}

/* ---- small screens: the chat takes the whole screen --------------------------- */

@media (max-width: 480px) {
  .zw-root:not(.zw-preview) .zw-panel {
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    width: 100%;
    max-width: 100%;
    height: 100%;
    max-height: 100%;
    border: none;
    border-radius: 0;
    animation-name: zw-rise;
  }

  /* the header's close button takes over while the chat covers the screen */
  .zw-root.zw-open:not(.zw-preview) .zw-launcher {
    display: none;
  }

  .zw-root:not(.zw-preview) .zw-composer {
    padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  }

  /* 16px prevents the iOS focus zoom */
  .zw-root:not(.zw-preview) .zw-input,
  .zw-root:not(.zw-preview) .zw-contact-fields input {
    font-size: 16px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .zw-panel,
  .zw-item,
  .zw-chips,
  .zw-teaser {
    animation: none;
  }

  .zw-typing-dot {
    animation: none;
    opacity: 0.6;
  }

  .zw-launcher,
  .zw-launcher-icons svg,
  .zw-chip,
  .zw-send {
    transition: none;
  }

  .zw-launcher:hover,
  .zw-chip:hover,
  .zw-send:hover {
    transform: none;
  }
}
`;
