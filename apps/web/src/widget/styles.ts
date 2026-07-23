/**
 * All widget styles live inline in the shadow root — no external stylesheet,
 * no CSS framework. The org theme color is injected via the --zw-color custom
 * property on the .zw-root element.
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
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 15px;
  line-height: 1.45;
  color: #1a1d23;
}

.zw-bubble {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483000;
  width: 56px;
  height: 56px;
  border: none;
  border-radius: 50%;
  background: var(--zw-color, #4f46e5);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.24);
}

.zw-bubble:hover {
  filter: brightness(1.08);
}

.zw-bubble:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

.zw-bubble svg {
  width: 26px;
  height: 26px;
}

.zw-unread {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 9px;
  background: #dc2626;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.zw-unread[hidden] {
  display: none;
}

.zw-panel {
  position: fixed;
  right: 20px;
  bottom: 88px;
  z-index: 2147483000;
  width: 360px;
  max-width: calc(100vw - 40px);
  height: 560px;
  max-height: calc(100vh - 108px);
  background: #fff;
  border-radius: 14px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
}

.zw-panel[hidden] {
  display: none;
}

.zw-header {
  background: var(--zw-color, #4f46e5);
  color: #fff;
  padding: 14px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
}

.zw-title {
  font-weight: 600;
  font-size: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zw-close {
  background: transparent;
  border: none;
  color: #fff;
  cursor: pointer;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  font-size: 20px;
  line-height: 1;
  flex-shrink: 0;
}

.zw-close:hover {
  background: rgba(255, 255, 255, 0.18);
}

.zw-close:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 1px;
}

.zw-banner {
  background: #fef3c7;
  color: #92400e;
  font-size: 12.5px;
  padding: 6px 12px;
  text-align: center;
  flex-shrink: 0;
}

.zw-banner[hidden] {
  display: none;
}

.zw-messages {
  flex: 1;
  overflow-y: auto;
  padding: 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #f6f7f9;
}

.zw-msg {
  max-width: 82%;
  padding: 8px 12px;
  border-radius: 14px;
  font-size: 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.zw-msg-in {
  align-self: flex-start;
  background: #fff;
  border: 1px solid #e2e5ea;
  border-bottom-left-radius: 4px;
}

.zw-msg-out {
  background: var(--zw-color, #4f46e5);
  color: #fff;
  border-bottom-right-radius: 4px;
  max-width: 100%;
}

.zw-typing {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 14px;
}

.zw-typing-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #9ca3af;
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

@media (prefers-reduced-motion: reduce) {
  .zw-typing-dot {
    animation: none;
    opacity: 0.6;
  }
}

.zw-out-wrap {
  align-self: flex-end;
  max-width: 82%;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.zw-status {
  font-size: 11px;
  color: #6b7280;
}

.zw-status-failed {
  color: #dc2626;
}

.zw-contact {
  border-top: 1px solid #e2e5ea;
  background: #fff;
  padding: 10px 12px;
  flex-shrink: 0;
}

.zw-contact[hidden] {
  display: none;
}

.zw-contact-hint {
  font-size: 12.5px;
  color: #6b7280;
  margin-bottom: 6px;
}

.zw-contact-fields {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}

.zw-contact-fields input {
  flex: 1;
  min-width: 0;
  border: 1px solid #e2e5ea;
  border-radius: 8px;
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
  background: #fff;
  color: inherit;
}

.zw-contact-fields input:focus {
  outline: 2px solid var(--zw-color, #4f46e5);
  outline-offset: 1px;
}

.zw-contact-error {
  font-size: 12px;
  color: #dc2626;
  margin-bottom: 6px;
}

.zw-contact-error[hidden] {
  display: none;
}

.zw-contact-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.zw-contact-save {
  background: var(--zw-color, #4f46e5);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.zw-contact-save:focus-visible,
.zw-contact-skip:focus-visible,
.zw-send:focus-visible {
  outline: 2px solid var(--zw-color, #4f46e5);
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
  color: #6b7280;
  font-size: 13px;
  cursor: pointer;
  text-decoration: underline;
  padding: 6px 2px;
}

.zw-composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  border-top: 1px solid #e2e5ea;
  padding: 10px 12px;
  background: #fff;
  flex-shrink: 0;
}

.zw-input {
  flex: 1;
  resize: none;
  border: 1px solid #e2e5ea;
  border-radius: 10px;
  padding: 8px 10px;
  font: inherit;
  font-size: 14px;
  max-height: 120px;
  background: #fff;
  color: inherit;
}

.zw-input:focus {
  outline: 2px solid var(--zw-color, #4f46e5);
  outline-offset: 1px;
  border-color: transparent;
}

.zw-send {
  background: var(--zw-color, #4f46e5);
  border: none;
  color: #fff;
  border-radius: 10px;
  padding: 8px 14px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  flex-shrink: 0;
}

.zw-send:hover {
  filter: brightness(1.08);
}

@media (max-width: 480px) {
  .zw-panel {
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    width: 100%;
    max-width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
  }

  /* 16px prevents the iOS focus zoom */
  .zw-input,
  .zw-contact-fields input {
    font-size: 16px;
  }
}
`;
