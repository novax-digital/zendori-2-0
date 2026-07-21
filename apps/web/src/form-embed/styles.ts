// Inline CSS for the embedded form (Shadow DOM). Theme values arrive as
// --zf-* custom properties set on the container by render.ts. The form is
// deliberately theme-agnostic (transparent background, neutral grays) so it
// works on arbitrary customer websites; only the accent color comes from the
// form design.

export const FORM_CSS = `
:host { all: initial; }
.zf {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: #0f172a;
  width: 100%;
  max-width: 640px;
  box-sizing: border-box;
  line-height: 1.5;
}
.zf *, .zf *::before, .zf *::after { box-sizing: border-box; }
.zf-title { font-size: 1.35rem; font-weight: 700; margin: 0 0 0.35rem; }
.zf-intro { font-size: 0.95rem; color: #475569; margin: 0 0 1.1rem; white-space: pre-line; }
.zf-field { margin-bottom: 0.95rem; }
.zf-label { display: block; font-size: 0.88rem; font-weight: 600; margin-bottom: 0.3rem; }
.zf-req { color: var(--zf-color); margin-left: 2px; }
.zf-input, .zf-select, .zf-textarea {
  width: 100%;
  font: inherit;
  font-size: 0.95rem;
  color: inherit;
  background: #ffffff;
  border: 1px solid #cbd5e1;
  border-radius: var(--zf-radius);
  padding: 0.55rem 0.75rem;
  outline: none;
}
.zf-textarea { min-height: 110px; resize: vertical; }
.zf-input:focus-visible, .zf-select:focus-visible, .zf-textarea:focus-visible {
  border-color: var(--zf-color);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--zf-color) 25%, transparent);
}
.zf-check { display: flex; gap: 0.55rem; align-items: flex-start; font-size: 0.88rem; }
.zf-check input { margin-top: 0.2rem; accent-color: var(--zf-color); }
.zf-radio-group { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.92rem; }
.zf-radio-group label { display: flex; gap: 0.5rem; align-items: center; }
.zf-radio-group input { accent-color: var(--zf-color); }
.zf-error { color: #b91c1c; font-size: 0.8rem; margin-top: 0.25rem; }
.zf-input[aria-invalid='true'], .zf-textarea[aria-invalid='true'], .zf-select[aria-invalid='true'] {
  border-color: #b91c1c;
}
.zf-legend { font-size: 0.78rem; color: #64748b; margin: 0.2rem 0 0.9rem; }
.zf-submit {
  font: inherit;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--zf-button-text);
  background: var(--zf-color);
  border: none;
  border-radius: var(--zf-button-radius);
  padding: 0.65rem 1.5rem;
  cursor: pointer;
}
.zf-submit:hover { filter: brightness(0.95); }
.zf-submit:focus-visible { outline: 2px solid var(--zf-color); outline-offset: 2px; }
.zf-submit[disabled] { opacity: 0.6; cursor: default; }
.zf-banner {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
  font-size: 0.88rem;
  border-radius: var(--zf-radius);
  padding: 0.6rem 0.8rem;
  margin-bottom: 0.9rem;
}
.zf-success { text-align: center; padding: 1.6rem 1rem; }
.zf-success-icon {
  width: 44px; height: 44px; border-radius: 999px;
  background: color-mix(in srgb, var(--zf-color) 15%, #ffffff);
  color: var(--zf-color);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 1.4rem; margin-bottom: 0.7rem;
}
.zf-success-text { font-size: 1rem; color: #0f172a; white-space: pre-line; }
.zf-privacy { font-size: 0.78rem; color: #64748b; margin-top: 0.8rem; }
.zf-privacy a { color: var(--zf-color); }
.zf-hp {
  position: absolute !important;
  left: -9999px !important;
  width: 1px; height: 1px; overflow: hidden;
}
`;
