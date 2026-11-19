import { buttonTextColor } from '../form-embed/render';
import { badge, el, iconButton, textControl, type Control } from '../demo-embed/render';
import { DEMO_CSS } from '../demo-embed/styles';

/**
 * Framework-free DOM of the contact embed: the form and the thank-you panel.
 * Shares look and DOM helpers with the demo embed (zendori.ai brand look).
 * Every user/API string goes through textContent — never innerHTML.
 */

export type ContactFieldKey = 'name' | 'email' | 'company' | 'phone' | 'topic' | 'message' | 'consent';
export type ContactFieldErrors = Partial<Record<ContactFieldKey, string>>;

export interface ContactFormValues {
  name: string;
  email: string;
  company: string;
  phone: string;
  topic: string;
  message: string;
  consent: boolean;
  /** Honeypot — humans never see it, so it stays empty. */
  nickname: string;
}

export interface ContactRenderOptions {
  accent: string | null;
  /** Head with icon + this title; null = the host page brings its own heading. */
  title: string | null;
  privacyUrl: string | null;
}

export interface ContactRenderHandles {
  readValues(): ContactFormValues;
  /** Client-side UX validation; the server re-validates everything. */
  validate(): boolean;
  setFieldErrors(errors: ContactFieldErrors): void;
  setSubmitting(submitting: boolean): void;
  showBanner(text: string | null): void;
  showSuccess(onReset: () => void): void;
  /** Back to an empty, submittable form. */
  showEmptyForm(): void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MESSAGE_MAX = 4000;
const SUBMIT_LABEL = 'Nachricht senden';
const BRAND_ACCENT = '#0b7480';
const BRAND_BUTTON = 'linear-gradient(135deg, #00805a 0%, #0070c4 100%)';
// Keep in sync with CONTACT_TOPICS / CONTACT_TOPIC_LABELS (@zendori/core
// contact.ts) — the embed bundle carries no zod and no core import.
const TOPICS: [string, string][] = [
  ['general', 'Allgemeine Anfrage'],
  ['demo', 'Demo und Beratung'],
  ['pricing', 'Preise und Pakete'],
  ['support', 'Hilfe zu meinem Konto'],
  ['partner', 'Partnerschaft'],
];
// Any change to this wording bumps CONTACT_CONSENT_VERSION (@zendori/core contact.ts).
const CONSENT_TEXT =
  'Ich bin einverstanden, dass Zendori meine Angaben verarbeitet, um meine Anfrage zu beantworten. Mehr dazu in der ';

export function renderContact(
  root: ShadowRoot,
  options: ContactRenderOptions,
  callbacks: { onSubmit(): void }
): ContactRenderHandles {
  root.replaceChildren();
  const style = document.createElement('style');
  style.textContent = DEMO_CSS;
  root.appendChild(style);

  const container = el('div', 'zd');
  container.style.setProperty('--zd-accent', options.accent ?? BRAND_ACCENT);
  container.style.setProperty('--zd-button', options.accent ?? BRAND_BUTTON);
  container.style.setProperty(
    '--zd-button-text',
    options.accent ? buttonTextColor(options.accent) : '#ffffff'
  );
  root.appendChild(container);
  const idPrefix = `zc${Math.floor(Math.random() * 1e6)}`;

  // --- form view ---------------------------------------------------------------
  const formView = el('div');
  if (options.title) {
    const head = el('div', 'zd-head');
    const headText = el('div');
    headText.append(
      el('div', 'zd-title', options.title),
      el('p', 'zd-sub', 'Wir melden uns so schnell wie möglich.')
    );
    head.append(badge('message', 17), headText);
    formView.appendChild(head);
  }
  const banner = el('div', 'zd-banner');
  banner.style.display = 'none';
  banner.setAttribute('role', 'alert');
  formView.appendChild(banner);

  const form = el('form');
  form.noValidate = true;
  formView.appendChild(form);

  const name = textControl(idPrefix, 'name', 'Dein Name', {
    required: true,
    autocomplete: 'name',
    placeholder: 'Alex Mustermann',
    maxLength: 120,
  });
  const email = textControl(idPrefix, 'email', 'E-Mail', {
    required: true,
    type: 'email',
    autocomplete: 'email',
    placeholder: 'alex@mustermann-solar.de',
  });
  const company = textControl(idPrefix, 'company', 'Firma (optional)', {
    required: false,
    autocomplete: 'organization',
    placeholder: 'Mustermann Solar GmbH',
    maxLength: 120,
  });
  const phone = textControl(idPrefix, 'phone', 'Telefon (optional)', {
    required: false,
    type: 'tel',
    autocomplete: 'tel',
    placeholder: '0170 1234567',
    maxLength: 40,
  });

  // topic select
  const topicWrap = el('div', 'zd-field zd-full');
  const topicLabel = el('label', 'zd-label', 'Worum geht es?');
  const topic = el('select', 'zd-select');
  topic.id = `${idPrefix}-topic`;
  topic.name = 'topic';
  topicLabel.htmlFor = topic.id;
  for (const [value, label] of TOPICS) {
    const option = el('option', undefined, label);
    option.value = value;
    topic.appendChild(option);
  }
  topicWrap.append(topicLabel, topic);

  const message = textControl(idPrefix, 'message', 'Deine Nachricht', {
    required: true,
    multiline: true,
    full: true,
    maxLength: MESSAGE_MAX,
    placeholder: 'Wobei können wir dir helfen?',
  });
  message.input.classList.add('zd-textarea--tall');
  const counter = el('div', 'zd-counter', `0/${MESSAGE_MAX}`);
  message.input.after(counter);
  message.input.addEventListener('input', () => {
    counter.textContent = `${message.input.value.length}/${MESSAGE_MAX}`;
  });

  const grid = el('div', 'zd-grid');
  grid.append(name.wrap, email.wrap, company.wrap, phone.wrap, topicWrap, message.wrap);
  form.appendChild(grid);

  // consent checkbox
  const consentWrap = el('div', 'zd-field');
  const consentLabel = el('label', 'zd-check');
  const consentInput = el('input');
  consentInput.type = 'checkbox';
  consentInput.id = `${idPrefix}-consent`;
  consentInput.setAttribute('aria-describedby', `${idPrefix}-consent-err`);
  consentInput.setAttribute('aria-required', 'true');
  const consentText = el('span', undefined, CONSENT_TEXT);
  // defense in depth: never set a non-http(s) href (javascript: XSS)
  if (options.privacyUrl && /^https?:\/\//i.test(options.privacyUrl)) {
    const link = el('a', undefined, 'Datenschutzerklärung');
    link.setAttribute('href', options.privacyUrl);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener');
    consentText.appendChild(link);
  } else {
    consentText.appendChild(document.createTextNode('Datenschutzerklärung'));
  }
  consentText.appendChild(document.createTextNode('.'));
  consentText.appendChild(el('span', 'zd-req', '*'));
  consentLabel.append(consentInput, consentText);
  const consentError = el('div', 'zd-error');
  consentError.id = `${idPrefix}-consent-err`;
  consentError.style.display = 'none';
  consentWrap.append(consentLabel, consentError);
  form.appendChild(consentWrap);
  const setConsentError = (text: string | null): void => {
    consentError.textContent = text ?? '';
    consentError.style.display = text ? 'block' : 'none';
    consentInput.setAttribute('aria-invalid', text ? 'true' : 'false');
  };

  // Honeypot: off-screen, never announced, skipped in tab order.
  const honeypot = el('input', 'zd-hp');
  honeypot.type = 'text';
  honeypot.name = 'nickname';
  honeypot.tabIndex = -1;
  honeypot.autocomplete = 'off';
  honeypot.setAttribute('aria-hidden', 'true');
  form.appendChild(honeypot);

  form.appendChild(el('p', 'zd-legend', '* Pflichtfeld'));
  const { button: submit, label: submitLabel } = iconButton(SUBMIT_LABEL, 'send');
  submit.type = 'submit';
  form.appendChild(submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    callbacks.onSubmit();
  });

  // --- success view ------------------------------------------------------------
  const successView = el('div', 'zd-center');
  successView.style.display = 'none';
  successView.setAttribute('role', 'status');
  const resetWrap = el('div', 'zd-actions');
  const resetButton = el('button', 'zd-link', 'Weitere Nachricht schreiben');
  resetButton.type = 'button';
  resetWrap.appendChild(resetButton);
  successView.append(
    badge('check', 22),
    el('div', 'zd-center-title', 'Danke für deine Nachricht!'),
    el(
      'p',
      'zd-center-text',
      'Sie ist bei uns angekommen. Wir melden uns so schnell wie möglich per E-Mail bei dir.'
    ),
    resetWrap
  );
  let resetHandler: (() => void) | null = null;
  resetButton.addEventListener('click', () => resetHandler?.());

  container.append(formView, successView);

  const controls: Record<'name' | 'email' | 'company' | 'phone' | 'message', Control> = {
    name,
    email,
    company,
    phone,
    message,
  };

  const handles: ContactRenderHandles = {
    readValues() {
      return {
        name: name.input.value.trim(),
        email: email.input.value.trim(),
        company: company.input.value.trim(),
        phone: phone.input.value.trim(),
        topic: topic.value,
        message: message.input.value.trim(),
        consent: consentInput.checked,
        nickname: honeypot.value,
      };
    },
    validate() {
      const values = handles.readValues();
      const errors: ContactFieldErrors = {};
      if (!values.name) errors.name = 'Bitte ausfüllen.';
      if (!values.email) errors.email = 'Bitte ausfüllen.';
      else if (!EMAIL_PATTERN.test(values.email)) {
        errors.email = 'Bitte eine gültige E-Mail-Adresse angeben.';
      }
      if (!values.message) errors.message = 'Bitte ausfüllen.';
      if (!values.consent) errors.consent = 'Bitte stimme zu, um fortzufahren.';
      handles.setFieldErrors(errors);
      return Object.keys(errors).length === 0;
    },
    setFieldErrors(errors) {
      let firstInvalid: HTMLElement | null = null;
      for (const [key, control] of Object.entries(controls) as [keyof typeof controls, Control][]) {
        const text = errors[key] ?? null;
        control.setError(text);
        if (text && !firstInvalid) firstInvalid = control.input;
      }
      setConsentError(errors.consent ?? null);
      if (errors.consent && !firstInvalid) firstInvalid = consentInput;
      firstInvalid?.focus();
    },
    setSubmitting(submitting) {
      submit.disabled = submitting;
      submitLabel.textContent = submitting ? 'Wird gesendet …' : SUBMIT_LABEL;
    },
    showBanner(text) {
      banner.textContent = text ?? '';
      banner.style.display = text ? 'block' : 'none';
    },
    showSuccess(onReset) {
      resetHandler = onReset;
      formView.style.display = 'none';
      successView.style.display = 'block';
    },
    showEmptyForm() {
      form.reset();
      counter.textContent = `0/${MESSAGE_MAX}`;
      handles.setFieldErrors({});
      handles.showBanner(null);
      handles.setSubmitting(false);
      successView.style.display = 'none';
      formView.style.display = 'block';
    },
  };
  return handles;
}
