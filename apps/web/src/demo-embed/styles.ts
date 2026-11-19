// Inline CSS for the demo embed (Shadow DOM). Theme-agnostic like the form
// embed (transparent background, neutral grays, white inputs) so it sits on
// arbitrary websites; only the accent color comes from data-accent
// (--zd-accent / --zd-accent-text on the container).

export const DEMO_CSS = `
:host { all: initial; display: block; }
.zd {
  container: zd / inline-size;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: #0f172a;
  width: 100%;
  max-width: 640px;
  box-sizing: border-box;
  line-height: 1.5;
}
.zd *, .zd *::before, .zd *::after { box-sizing: border-box; }
.zd-title { font-size: 1.35rem; font-weight: 700; margin: 0 0 0.35rem; }
.zd-intro { font-size: 0.95rem; color: #475569; margin: 0 0 1.1rem; }
.zd-row { display: flex; flex-wrap: wrap; gap: 0 1rem; }
.zd-row > .zd-field { flex: 1 1 220px; min-width: 0; }
.zd-field { margin-bottom: 0.95rem; }
.zd-label { display: block; font-size: 0.88rem; font-weight: 600; margin-bottom: 0.3rem; }
.zd-req { color: var(--zd-accent); margin-left: 2px; }
.zd-input, .zd-textarea {
  width: 100%;
  font: inherit;
  font-size: 0.95rem;
  color: inherit;
  background: #ffffff;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  padding: 0.55rem 0.75rem;
  outline: none;
}
.zd-textarea { min-height: 96px; resize: vertical; }
.zd-input:focus-visible, .zd-textarea:focus-visible {
  border-color: var(--zd-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--zd-accent) 25%, transparent);
}
.zd-input[aria-invalid='true'], .zd-textarea[aria-invalid='true'] { border-color: #b91c1c; }
.zd-hint { font-size: 0.78rem; color: #64748b; margin-top: 0.25rem; }
.zd-counter { font-size: 0.75rem; color: #94a3b8; text-align: right; margin-top: 0.2rem; }
.zd-check { display: flex; gap: 0.55rem; align-items: flex-start; font-size: 0.82rem; color: #334155; }
.zd-check input { margin-top: 0.2rem; flex-shrink: 0; accent-color: var(--zd-accent); }
.zd-check input:focus-visible { outline: 2px solid var(--zd-accent); outline-offset: 2px; }
.zd-check a { color: var(--zd-accent); }
.zd-error { color: #b91c1c; font-size: 0.8rem; margin-top: 0.25rem; }
.zd-legend { font-size: 0.78rem; color: #64748b; margin: 0.2rem 0 0.9rem; }
.zd-button {
  font: inherit;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--zd-accent-text);
  background: var(--zd-accent);
  border: none;
  border-radius: 10px;
  padding: 0.65rem 1.5rem;
  cursor: pointer;
}
.zd-button:hover { filter: brightness(0.95); }
.zd-button:focus-visible { outline: 2px solid var(--zd-accent); outline-offset: 2px; }
.zd-button[disabled] { opacity: 0.6; cursor: default; }
@container zd (max-width: 520px) { .zd-button { width: 100%; } }
.zd-banner {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
  font-size: 0.88rem;
  border-radius: 10px;
  padding: 0.6rem 0.8rem;
  margin-bottom: 0.9rem;
}
.zd-hp { position: absolute !important; left: -9999px !important; width: 1px; height: 1px; overflow: hidden; }
.zd-success { text-align: center; padding: 1.4rem 0.5rem; }
.zd-success-icon {
  width: 44px; height: 44px; border-radius: 999px;
  background: color-mix(in srgb, var(--zd-accent) 15%, #ffffff);
  color: var(--zd-accent);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 1.4rem; margin-bottom: 0.7rem;
}
.zd-success-title { font-size: 1.2rem; font-weight: 700; margin: 0 0 0.4rem; }
.zd-success-text { font-size: 0.95rem; color: #334155; margin: 0 0 1rem; overflow-wrap: anywhere; }
.zd-status {
  display: inline-flex; align-items: center; gap: 0.55rem;
  font-size: 0.92rem; font-weight: 600; color: #0f172a;
  background: #f1f5f9; border-radius: 999px; padding: 0.45rem 0.95rem;
}
.zd-dot { width: 9px; height: 9px; border-radius: 999px; background: var(--zd-accent); flex-shrink: 0; }
.zd-dot--live { animation: zd-pulse 1.4s ease-in-out infinite; }
@keyframes zd-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.75); } }
@media (prefers-reduced-motion: reduce) { .zd-dot--live { animation: none; } }
.zd-reset { margin-top: 1rem; }
.zd-code { text-align: center; padding: 1rem 0.25rem; }
.zd-code-form { max-width: 320px; margin: 0 auto; }
.zd-code-input {
  text-align: center;
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: 0.35em;
  font-variant-numeric: tabular-nums;
}
.zd-code-form .zd-button { width: 100%; margin-top: 0.2rem; }
.zd-info { font-size: 0.82rem; color: #475569; margin-top: 0.5rem; min-height: 1.2em; }
.zd-actions {
  display: flex; flex-wrap: wrap; justify-content: center; gap: 0.35rem 1.1rem;
  margin-top: 1rem;
}
.zd-link {
  font: inherit; font-size: 0.85rem; color: var(--zd-accent);
  background: none; border: none; padding: 0.15rem 0; cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
}
.zd-link[disabled] { color: #94a3b8; cursor: default; text-decoration: none; }
.zd-link:focus-visible { outline: 2px solid var(--zd-accent); outline-offset: 2px; }
`;
