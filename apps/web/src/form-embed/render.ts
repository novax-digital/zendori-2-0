import { FORM_CSS } from './styles';
import type { FormValues, PublicFormDefinition, PublicFormField } from './types';

/**
 * The ONE form renderer (framework-free DOM): used by the embed bundle
 * (form.js), the hosted page /f/[token] and the builder's live preview — so
 * the preview is by construction identical to production (concept: WYSIWYG
 * without drift). `mode: 'preview'` disables the submit handler.
 */

export interface RenderOptions {
  mode: 'live' | 'preview';
  /** Hide the title/intro block (inline embeds can opt out). */
  showTitle?: boolean;
  onSubmit?: () => void;
}

export interface RenderHandles {
  /** Collected values (strings; checkboxes as boolean). */
  readValues(): FormValues;
  /** Honeypot value (must stay empty for humans). */
  honeypotValue(): string;
  /** Client-side validation for UX; the server re-validates. */
  validate(): boolean;
  setSubmitting(submitting: boolean): void;
  showBanner(text: string | null): void;
  showSuccess(): void;
  /** Reset to a pristine, re-submittable form (preview toggle). */
  showForm(): void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RADIUS: Record<string, { input: string; button: string }> = {
  square: { input: '4px', button: '4px' },
  rounded: { input: '10px', button: '10px' },
  pill: { input: '10px', button: '999px' },
};

/** WCAG relative luminance → black or white button text. */
export function buttonTextColor(hex: string): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return '#ffffff';
  const raw = match[1] ?? '';
  const channel = (offset: number): number => {
    const c = parseInt(raw.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.45 ? '#0f172a' : '#ffffff';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface FieldControl {
  field: PublicFormField;
  read(): string | boolean;
  setError(message: string | null): void;
  focus(): void;
}

function labelFor(field: PublicFormField, inputId: string): HTMLLabelElement {
  const label = el('label', 'zf-label');
  label.htmlFor = inputId;
  label.textContent = field.label;
  if (field.required) label.appendChild(el('span', 'zf-req', '*'));
  return label;
}

function buildField(field: PublicFormField, idPrefix: string): {
  wrap: HTMLElement;
  control: FieldControl;
} {
  const wrap = el('div', 'zf-field');
  const inputId = `${idPrefix}-${field.key}`;
  const errorId = `${inputId}-err`;
  const error = el('div', 'zf-error');
  error.id = errorId;
  error.style.display = 'none';

  let read: () => string | boolean;
  let invalidTarget: HTMLElement | null = null;
  let focusTarget: HTMLElement | null = null;

  if (field.type === 'checkbox' || field.type === 'consent') {
    const label = el('label', 'zf-check');
    const input = el('input');
    input.type = 'checkbox';
    input.id = inputId;
    input.setAttribute('aria-describedby', errorId);
    const text = el('span');
    text.textContent =
      field.type === 'consent' ? (field.consentText ?? field.label) : field.label;
    label.append(input, text);
    wrap.append(label, error);
    read = () => input.checked;
    invalidTarget = input;
    focusTarget = input;
  } else if (field.type === 'select') {
    wrap.appendChild(labelFor(field, inputId));
    const select = el('select', 'zf-select');
    select.id = inputId;
    select.setAttribute('aria-describedby', errorId);
    const placeholder = el('option', undefined, field.placeholder ?? 'Bitte wählen …');
    placeholder.value = '';
    select.appendChild(placeholder);
    for (const option of field.options ?? []) {
      const node = el('option', undefined, option);
      node.value = option;
      select.appendChild(node);
    }
    wrap.append(select, error);
    read = () => select.value;
    invalidTarget = select;
    focusTarget = select;
  } else if (field.type === 'radio') {
    wrap.appendChild(labelFor(field, inputId));
    const group = el('div', 'zf-radio-group');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-describedby', errorId);
    const inputs: HTMLInputElement[] = [];
    (field.options ?? []).forEach((option, index) => {
      const label = el('label');
      const input = el('input');
      input.type = 'radio';
      input.name = inputId;
      input.value = option;
      if (index === 0) input.id = inputId;
      inputs.push(input);
      label.append(input, el('span', undefined, option));
      group.appendChild(label);
    });
    wrap.append(group, error);
    read = () => inputs.find((i) => i.checked)?.value ?? '';
    invalidTarget = group;
    focusTarget = inputs[0] ?? group;
  } else if (field.type === 'textarea') {
    wrap.appendChild(labelFor(field, inputId));
    const textarea = el('textarea', 'zf-textarea');
    textarea.id = inputId;
    if (field.placeholder) textarea.placeholder = field.placeholder;
    textarea.maxLength = field.maxLength ?? 5000;
    textarea.setAttribute('aria-describedby', errorId);
    wrap.append(textarea, error);
    read = () => textarea.value;
    invalidTarget = textarea;
    focusTarget = textarea;
  } else {
    // text | email | phone | date
    wrap.appendChild(labelFor(field, inputId));
    const input = el('input', 'zf-input');
    input.id = inputId;
    input.type =
      field.type === 'email'
        ? 'email'
        : field.type === 'phone'
          ? 'tel'
          : field.type === 'date'
            ? 'date'
            : 'text';
    if (field.placeholder) input.placeholder = field.placeholder;
    input.maxLength = field.maxLength ?? 500;
    input.setAttribute('aria-describedby', errorId);
    wrap.append(input, error);
    read = () => input.value;
    invalidTarget = input;
    focusTarget = input;
  }

  const control: FieldControl = {
    field,
    read,
    setError(message) {
      error.textContent = message ?? '';
      error.style.display = message ? 'block' : 'none';
      invalidTarget?.setAttribute('aria-invalid', message ? 'true' : 'false');
    },
    focus() {
      focusTarget?.focus();
    },
  };
  return { wrap, control };
}

export function renderForm(
  host: ShadowRoot | HTMLElement,
  definition: PublicFormDefinition,
  options: RenderOptions
): RenderHandles {
  host.replaceChildren();

  const style = document.createElement('style');
  style.textContent = FORM_CSS;
  host.appendChild(style);

  const design = definition.design;
  const radius = RADIUS[design.radius] ?? RADIUS.rounded!;
  const container = el('div', 'zf');
  container.style.setProperty('--zf-color', design.color);
  container.style.setProperty('--zf-radius', radius.input);
  container.style.setProperty('--zf-button-radius', radius.button);
  container.style.setProperty('--zf-button-text', buttonTextColor(design.color));
  host.appendChild(container);

  const idPrefix = `zf${Math.floor(Math.random() * 1e6)}`;

  const formView = el('div');
  const successView = el('div', 'zf-success');
  successView.style.display = 'none';
  successView.setAttribute('role', 'status');
  const successIcon = el('div', 'zf-success-icon', '✓');
  const successText = el('div', 'zf-success-text', design.successMessage);
  successView.append(successIcon, successText);
  container.append(formView, successView);

  if (options.showTitle !== false && (design.title || design.intro)) {
    if (design.title) formView.appendChild(el('div', 'zf-title', design.title));
    if (design.intro) formView.appendChild(el('p', 'zf-intro', design.intro));
  }

  const banner = el('div', 'zf-banner');
  banner.style.display = 'none';
  banner.setAttribute('aria-live', 'polite');
  formView.appendChild(banner);

  const form = el('form');
  form.noValidate = true;
  formView.appendChild(form);

  const controls: FieldControl[] = [];
  for (const field of definition.fields) {
    const { wrap, control } = buildField(field, idPrefix);
    form.appendChild(wrap);
    controls.push(control);
  }

  // Honeypot: visually hidden, never announced, skipped in tab order.
  const honeypot = el('input', 'zf-hp');
  honeypot.type = 'text';
  honeypot.name = 'website';
  honeypot.tabIndex = -1;
  honeypot.autocomplete = 'off';
  honeypot.setAttribute('aria-hidden', 'true');
  form.appendChild(honeypot);

  if (definition.fields.some((f) => f.required)) {
    form.appendChild(el('p', 'zf-legend', '* Pflichtfeld'));
  }

  const submit = el('button', 'zf-submit', design.submitLabel);
  submit.type = 'submit';
  form.appendChild(submit);

  // defense in depth: the schema already restricts the scheme, but the
  // renderer must never set a non-http(s) href (stored XSS via javascript:)
  if (definition.privacyPolicyUrl && /^https?:\/\//i.test(definition.privacyPolicyUrl)) {
    const privacy = el('p', 'zf-privacy');
    const link = el('a', undefined, 'Datenschutzerklärung');
    link.setAttribute('href', definition.privacyPolicyUrl);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener');
    privacy.appendChild(link);
    formView.appendChild(privacy);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (options.mode === 'preview') return;
    options.onSubmit?.();
  });

  return {
    readValues() {
      const values: FormValues = {};
      for (const control of controls) {
        const value = control.read();
        if (typeof value === 'boolean') {
          if (value) values[control.field.key] = true;
        } else if (value.trim().length > 0) {
          values[control.field.key] = value.trim();
        }
      }
      return values;
    },
    honeypotValue() {
      return honeypot.value;
    },
    validate() {
      let firstInvalid: FieldControl | null = null;
      for (const control of controls) {
        const { field } = control;
        const value = control.read();
        let message: string | null = null;
        if (field.type === 'checkbox' || field.type === 'consent') {
          if (field.required && value !== true) {
            message =
              field.type === 'consent'
                ? 'Bitte stimmen Sie zu, um fortzufahren.'
                : 'Bitte ankreuzen.';
          }
        } else {
          const text = typeof value === 'string' ? value.trim() : '';
          if (field.required && text.length === 0) message = 'Bitte ausfüllen.';
          else if (field.type === 'email' && text.length > 0 && !EMAIL_PATTERN.test(text)) {
            message = 'Bitte eine gültige E-Mail-Adresse angeben.';
          }
        }
        control.setError(message);
        if (message && !firstInvalid) firstInvalid = control;
      }
      if (firstInvalid) {
        firstInvalid.focus();
        return false;
      }
      return true;
    },
    setSubmitting(submitting) {
      submit.disabled = submitting;
      submit.textContent = submitting ? 'Wird gesendet …' : design.submitLabel;
    },
    showBanner(text) {
      banner.textContent = text ?? '';
      banner.style.display = text ? 'block' : 'none';
    },
    showSuccess() {
      formView.style.display = 'none';
      successView.style.display = 'block';
    },
    showForm() {
      successView.style.display = 'none';
      formView.style.display = 'block';
    },
  };
}
