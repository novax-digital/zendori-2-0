// Inline CSS for the demo embed (Shadow DOM). The demo is Zendori's own lead
// form, so it carries the zendori.ai brand look (Brand Guidelines v1.0, same
// tokens as the marketing site): Sora headings + Inter text — both resolve to
// the host page's @font-face, with system fallbacks elsewhere — mist inputs,
// pill button in the darkened brand gradient (white text ≥ 4.9:1).
// Background stays transparent: the host wraps the form in its own card.
// data-accent replaces the gradient with one solid color (--zd-button /
// --zd-button-text / --zd-accent are set per mount on the container).

export const DEMO_CSS = `
:host { all: initial; display: block; }
.zd {
  container: zd / inline-size;
  --zd-ink: #0b1220;
  --zd-text: #334155;
  --zd-muted: #64748b;
  --zd-faint: #94a3b8;
  --zd-line: #e2e8f0;
  --zd-line-strong: #cbd5e1;
  --zd-mist: #f4f7fa;
  --zd-soft: linear-gradient(135deg, #e6fbf3 0%, #e6f4ff 100%);
  --zd-danger: #b91c1c;
  --zd-head: 'Sora', 'Avenir Next', 'Segoe UI', system-ui, sans-serif;
  font-family: 'Inter', 'Helvetica Neue', Arial, system-ui, sans-serif;
  color: var(--zd-text);
  width: 100%;
  box-sizing: border-box;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.zd *, .zd *::before, .zd *::after { box-sizing: border-box; }
.zd svg { display: block; flex-shrink: 0; }

/* head: icon + title + subline */
.zd-head { display: flex; gap: 0.8rem; align-items: center; margin: 0 0 1.25rem; }
.zd-badge {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.6rem; height: 2.6rem; border-radius: 50%;
  background: var(--zd-soft); color: var(--zd-accent); flex-shrink: 0;
}
.zd-title {
  font-family: var(--zd-head); font-weight: 600; font-size: 1.1rem;
  color: var(--zd-ink); line-height: 1.3; margin: 0;
}
.zd-sub { font-size: 0.85rem; color: var(--zd-muted); margin: 0.1rem 0 0; }

/* fields */
.zd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 0.8rem; }
.zd-grid .zd-full { grid-column: 1 / -1; }
@container zd (max-width: 480px) { .zd-grid { grid-template-columns: 1fr; } }
.zd-field { margin-bottom: 0.85rem; min-width: 0; }
.zd-label { display: block; font-size: 0.82rem; font-weight: 600; color: var(--zd-ink); margin-bottom: 0.35rem; }
.zd-req { color: var(--zd-accent); margin-left: 2px; }
.zd-input, .zd-textarea {
  width: 100%;
  font: inherit;
  font-size: 0.95rem;
  color: var(--zd-ink);
  background: var(--zd-mist);
  border: 1px solid var(--zd-line);
  border-radius: 10px;
  padding: 0.7rem 0.85rem;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
}
.zd-input::placeholder, .zd-textarea::placeholder { color: var(--zd-faint); opacity: 1; }
.zd-textarea { min-height: 96px; resize: vertical; }
.zd-input:hover, .zd-textarea:hover { border-color: var(--zd-line-strong); }
.zd-input:focus-visible, .zd-textarea:focus-visible {
  background: #ffffff;
  border-color: var(--zd-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--zd-accent) 18%, transparent);
}
.zd-input[aria-invalid='true'], .zd-textarea[aria-invalid='true'] { border-color: var(--zd-danger); }
.zd-hint { font-size: 0.78rem; color: var(--zd-muted); margin-top: 0.3rem; }
.zd-counter { font-size: 0.75rem; color: var(--zd-faint); text-align: right; margin-top: 0.2rem; }
.zd-error { color: var(--zd-danger); font-size: 0.8rem; margin-top: 0.3rem; }

/* consent */
.zd-check { display: flex; gap: 0.6rem; align-items: flex-start; font-size: 0.8rem; line-height: 1.5; color: var(--zd-muted); }
.zd-check input {
  width: 1.05rem; height: 1.05rem; margin: 0.12rem 0 0; flex-shrink: 0;
  accent-color: var(--zd-accent); cursor: pointer;
}
.zd-check input:focus-visible { outline: 2px solid var(--zd-accent); outline-offset: 2px; }
.zd-check a { color: var(--zd-accent); text-underline-offset: 2px; }
.zd-legend { font-size: 0.75rem; color: var(--zd-faint); margin: 0.1rem 0 0.9rem; }

/* buttons */
.zd-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.55rem;
  width: 100%;
  font-family: var(--zd-head);
  font-size: 0.98rem;
  font-weight: 600;
  color: var(--zd-button-text);
  background: var(--zd-button);
  border: none;
  border-radius: 999px;
  padding: 0.95rem 1.4rem;
  cursor: pointer;
  box-shadow: 0 10px 24px -10px rgba(0, 112, 196, 0.6);
  transition: filter 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
}
.zd-button:hover { filter: brightness(0.92); transform: translateY(-1px); }
.zd-button:active { transform: none; }
.zd-button:focus-visible { outline: 2px solid var(--zd-accent); outline-offset: 3px; }
.zd-button[disabled] { opacity: 0.6; cursor: default; transform: none; filter: none; box-shadow: none; }
@media (prefers-reduced-motion: reduce) {
  .zd-button, .zd-input, .zd-textarea { transition: none; }
  .zd-button:hover { transform: none; }
}

.zd-banner {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
  font-size: 0.86rem;
  border-radius: 10px;
  padding: 0.65rem 0.85rem;
  margin: 0 0 0.9rem;
}
.zd-hp { position: absolute !important; left: -9999px !important; width: 1px; height: 1px; overflow: hidden; }

/* code step + success */
.zd-center { text-align: center; padding: 0.75rem 0.25rem; }
.zd-center .zd-badge { width: 3.2rem; height: 3.2rem; margin: 0 auto 0.85rem; }
.zd-center-title {
  font-family: var(--zd-head); font-weight: 600; font-size: 1.2rem;
  color: var(--zd-ink); margin: 0 0 0.45rem;
}
.zd-center-text { font-size: 0.93rem; color: var(--zd-text); margin: 0 auto 1.1rem; max-width: 42ch; overflow-wrap: anywhere; }
.zd-code-form { max-width: 320px; margin: 0 auto; text-align: left; }
.zd-code-input {
  text-align: center;
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: 0.35em;
  font-variant-numeric: tabular-nums;
  background: #ffffff;
}
.zd-code-form .zd-button { margin-top: 0.3rem; }
.zd-info { font-size: 0.82rem; color: var(--zd-muted); margin-top: 0.55rem; min-height: 1.2em; text-align: center; }
.zd-actions {
  display: flex; flex-wrap: wrap; justify-content: center; gap: 0.35rem 1.2rem;
  margin-top: 0.9rem;
}
.zd-link {
  font: inherit; font-size: 0.85rem; font-weight: 500; color: var(--zd-accent);
  background: none; border: none; padding: 0.15rem 0; cursor: pointer;
  text-decoration: underline; text-underline-offset: 3px;
}
.zd-link[disabled] { color: var(--zd-faint); cursor: default; text-decoration: none; }
.zd-link:focus-visible { outline: 2px solid var(--zd-accent); outline-offset: 2px; }
.zd-status {
  display: inline-flex; align-items: center; gap: 0.6rem;
  font-size: 0.9rem; font-weight: 500; color: var(--zd-ink);
  background: var(--zd-mist); border: 1px solid var(--zd-line);
  border-radius: 999px; padding: 0.5rem 1rem;
}
.zd-dot { width: 9px; height: 9px; border-radius: 999px; background: #00d084; flex-shrink: 0; }
.zd-dot--live { animation: zd-pulse 1.4s ease-in-out infinite; }
@keyframes zd-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.75); } }
@media (prefers-reduced-motion: reduce) { .zd-dot--live { animation: none; } }
.zd-reset { margin-top: 1.1rem; }
.zd-reset .zd-banner { text-align: left; }
`;
