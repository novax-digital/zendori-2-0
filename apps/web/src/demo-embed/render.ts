import { buttonTextColor } from '../form-embed/render';
import { DEMO_CSS } from './styles';
import type {
  DemoFieldErrors,
  DemoFieldKey,
  DemoFormValues,
  DemoMountOptions,
  DemoVerifyChannel,
} from './types';

/**
 * Framework-free DOM for the demo embed: the request form, the code step
 * (SMS/voice verification of the number) and the success panel with the live
 * call status. Every user/API string goes through textContent — never innerHTML.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROMPT_MAX = 1000;
const SUBMIT_LABEL = 'Code anfordern & anrufen lassen';
const SUBTITLE = 'Dauert ca. 1 Minute';
/** Brand defaults (zendori.ai): readable teal for links/focus, darkened brand gradient for buttons. */
const BRAND_ACCENT = '#0b7480';
const BRAND_BUTTON = 'linear-gradient(135deg, #00805a 0%, #0070c4 100%)';
// First-person wording (unchanged since DEMO_CONSENT_VERSION 2026-11-13).
const CONSENT_TEXT =
  'Ich möchte auf die angegebene Nummer einen Bestätigungscode (per SMS oder Anruf) und einen Demo-Anruf eines KI-Assistenten erhalten und willige in die Verarbeitung meiner Angaben zu diesem Zweck und zur Kontaktaufnahme durch Zendori ein. Der Anruf wird von einer KI geführt; dabei werden Daten auch durch xAI und Twilio (USA) verarbeitet. Mehr in der ';
const VERIFY_LABEL = 'Bestätigen & Anruf starten';

export interface DemoRenderCallbacks {
  onSubmit(): void;
  onVerify(): void;
  onResend(channel: DemoVerifyChannel): void;
  /** "Nummer ändern": back to the filled form. */
  onChangeNumber(): void;
}

export interface DemoRenderHandles {
  readValues(): DemoFormValues;
  /** Client-side UX validation; the server re-validates everything. */
  validate(): boolean;
  setFieldErrors(errors: DemoFieldErrors): void;
  setSubmitting(submitting: boolean): void;
  showBanner(text: string | null): void;
  /** Code step after a successful request. */
  showCodeStep(phone: string, channel: DemoVerifyChannel): void;
  /** Where the latest code went (SMS or call) — updates the explanation. */
  setCodeChannel(channel: DemoVerifyChannel): void;
  readCode(): string;
  setCodeError(text: string | null): void;
  setCodeInfo(text: string | null): void;
  setVerifying(verifying: boolean): void;
  /** Resend links: countdown while cooling down, hidden once the budget is used. */
  setResendState(state: { secondsLeft: number; exhausted: boolean }): void;
  /** Unrecoverable code-step state (expired, too many attempts): message + reset. */
  showCodeFatal(text: string, onReset: () => void): void;
  /** Back to the form with the entered values kept. */
  showForm(): void;
  showSuccess(): void;
  setStatus(text: string, live: boolean): void;
  /** Shows (callback) or hides (null) the "Neue Demo anfordern" button. */
  setReset(onReset: (() => void) | null): void;
  /** Back to an empty, submittable form. */
  showEmptyForm(): void;
}

/** Stroke icons (Lucide geometry, 24×24 viewBox) — static path data only. */
const ICON_PATHS = {
  phone:
    'M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  check: 'M20 6 9 17l-5-5',
} as const;

function icon(name: keyof typeof ICON_PATHS, size: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.appendChild(path);
  return svg;
}

function badge(name: keyof typeof ICON_PATHS, size: number): HTMLElement {
  const node = el('span', 'zd-badge');
  node.appendChild(icon(name, size));
  return node;
}

/** Pill button with a leading icon; returns the label node for state texts. */
function iconButton(label: string, name: keyof typeof ICON_PATHS | null): {
  button: HTMLButtonElement;
  label: HTMLSpanElement;
} {
  const button = el('button', 'zd-button');
  if (name) button.appendChild(icon(name, 17));
  const text = el('span', undefined, label);
  button.appendChild(text);
  return { button, label: text };
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

interface Control {
  wrap: HTMLElement;
  input: HTMLInputElement | HTMLTextAreaElement;
  setError(message: string | null): void;
}

function textControl(
  idPrefix: string,
  key: DemoFieldKey,
  label: string,
  options: {
    required: boolean;
    type?: 'text' | 'email' | 'tel';
    autocomplete?: string;
    placeholder?: string;
    hint?: string;
    multiline?: boolean;
    full?: boolean;
  }
): Control {
  const wrap = el('div', options.full ? 'zd-field zd-full' : 'zd-field');
  const id = `${idPrefix}-${key}`;
  const errorId = `${id}-err`;
  const labelNode = el('label', 'zd-label', label);
  labelNode.htmlFor = id;
  if (options.required) labelNode.appendChild(el('span', 'zd-req', '*'));

  let input: HTMLInputElement | HTMLTextAreaElement;
  if (options.multiline) {
    const textarea = el('textarea', 'zd-textarea');
    textarea.maxLength = PROMPT_MAX;
    input = textarea;
  } else {
    const field = el('input', 'zd-input');
    field.type = options.type ?? 'text';
    field.maxLength = key === 'websiteUrl' ? 300 : 200;
    // setAttribute: TS's AutoFill union lacks some valid tokens (e.g. "url")
    if (options.autocomplete) field.setAttribute('autocomplete', options.autocomplete);
    input = field;
  }
  input.id = id;
  input.name = key;
  if (options.placeholder) input.placeholder = options.placeholder;
  input.setAttribute('aria-describedby', errorId);
  if (options.required) input.setAttribute('aria-required', 'true');

  const error = el('div', 'zd-error');
  error.id = errorId;
  error.style.display = 'none';
  wrap.append(labelNode, input);
  if (options.hint) wrap.appendChild(el('div', 'zd-hint', options.hint));
  wrap.appendChild(error);

  return {
    wrap,
    input,
    setError(message) {
      error.textContent = message ?? '';
      error.style.display = message ? 'block' : 'none';
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
    },
  };
}

export function renderDemo(
  root: ShadowRoot,
  options: DemoMountOptions,
  callbacks: DemoRenderCallbacks
): DemoRenderHandles {
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

  const idPrefix = `zd${Math.floor(Math.random() * 1e6)}`;

  // --- form view ---------------------------------------------------------------
  const formView = el('div');
  const head = el('div', 'zd-head');
  const headText = el('div');
  headText.append(el('div', 'zd-title', options.title), el('p', 'zd-sub', SUBTITLE));
  head.append(badge('phone', 17), headText);
  formView.appendChild(head);
  const banner = el('div', 'zd-banner');
  banner.style.display = 'none';
  banner.setAttribute('role', 'alert');
  formView.appendChild(banner);

  const form = el('form');
  form.noValidate = true;
  formView.appendChild(form);

  const company = textControl(idPrefix, 'company', 'Firma', {
    required: true,
    autocomplete: 'organization',
    placeholder: 'Mustermann Solar GmbH',
  });
  const contactName = textControl(idPrefix, 'contactName', 'Dein Name', {
    required: true,
    autocomplete: 'name',
    placeholder: 'Alex Mustermann',
  });
  const email = textControl(idPrefix, 'email', 'Geschäftliche E-Mail', {
    required: true,
    type: 'email',
    autocomplete: 'email',
    placeholder: 'alex@mustermann-solar.de',
  });
  const phone = textControl(idPrefix, 'phone', 'Telefonnummer', {
    required: true,
    type: 'tel',
    autocomplete: 'tel',
    placeholder: '0170 1234567',
    hint: 'Deutsche Mobil- oder Festnetznummer',
  });
  const websiteUrl = textControl(idPrefix, 'websiteUrl', 'Website (optional)', {
    required: false,
    autocomplete: 'url',
    placeholder: 'www.mustermann-solar.de',
    hint: 'Der Agent liest deine Startseite und kennt dann dein Angebot.',
    full: true,
  });
  const prompt = textControl(idPrefix, 'prompt', 'Was soll der Agent tun? (optional)', {
    required: false,
    multiline: true,
    full: true,
    placeholder:
      'z. B. Ruf mich als Kunde an, der einen Beratungstermin für eine PV-Anlage möchte, und frag nach meiner Adresse.',
  });
  const counter = el('div', 'zd-counter', `0/${PROMPT_MAX}`);
  prompt.input.after(counter);
  prompt.input.addEventListener('input', () => {
    counter.textContent = `${prompt.input.value.length}/${PROMPT_MAX}`;
  });

  const grid = el('div', 'zd-grid');
  grid.append(company.wrap, contactName.wrap, email.wrap, phone.wrap, websiteUrl.wrap, prompt.wrap);
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
  const setConsentError = (message: string | null): void => {
    consentError.textContent = message ?? '';
    consentError.style.display = message ? 'block' : 'none';
    consentInput.setAttribute('aria-invalid', message ? 'true' : 'false');
  };

  // Honeypot: off-screen, never announced, skipped in tab order. Not named
  // "website" — that would collide with browsers' autofill for the URL field.
  const honeypot = el('input', 'zd-hp');
  honeypot.type = 'text';
  honeypot.name = 'nickname';
  honeypot.tabIndex = -1;
  honeypot.autocomplete = 'off';
  honeypot.setAttribute('aria-hidden', 'true');
  form.appendChild(honeypot);

  form.appendChild(el('p', 'zd-legend', '* Pflichtfeld'));
  const { button: submit, label: submitLabel } = iconButton(SUBMIT_LABEL, 'phone');
  submit.type = 'submit';
  form.appendChild(submit);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    callbacks.onSubmit();
  });

  // --- code view (phone verification) --------------------------------------------
  const codeView = el('div', 'zd-center');
  codeView.style.display = 'none';
  const codeText = el('p', 'zd-center-text');
  const codeForm = el('form', 'zd-code-form');
  codeForm.noValidate = true;
  const codeLabel = el('label', 'zd-label', 'Bestätigungscode');
  const codeInput = el('input', 'zd-input zd-code-input');
  codeInput.id = `${idPrefix}-code`;
  codeLabel.htmlFor = codeInput.id;
  codeInput.type = 'text';
  codeInput.inputMode = 'numeric';
  codeInput.maxLength = 10;
  codeInput.setAttribute('autocomplete', 'one-time-code');
  codeInput.setAttribute('aria-describedby', `${idPrefix}-code-err`);
  const codeError = el('div', 'zd-error');
  codeError.id = `${idPrefix}-code-err`;
  codeError.setAttribute('role', 'alert');
  codeError.style.display = 'none';
  const codeInfo = el('div', 'zd-info');
  codeInfo.setAttribute('aria-live', 'polite');
  const { button: verifyButton, label: verifyLabel } = iconButton(VERIFY_LABEL, 'phone');
  verifyButton.type = 'submit';
  codeForm.append(codeLabel, codeInput, codeError, verifyButton, codeInfo);
  codeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    callbacks.onVerify();
  });

  const codeActions = el('div', 'zd-actions');
  const resendButton = el('button', 'zd-link', 'Code erneut senden');
  resendButton.type = 'button';
  const callButton = el('button', 'zd-link', 'Code per Anruf erhalten');
  callButton.type = 'button';
  const changeButton = el('button', 'zd-link', 'Nummer ändern');
  changeButton.type = 'button';
  codeActions.append(resendButton, callButton, changeButton);
  let codeChannel: DemoVerifyChannel = 'sms';
  resendButton.addEventListener('click', () => callbacks.onResend(codeChannel));
  callButton.addEventListener('click', () => callbacks.onResend('call'));
  changeButton.addEventListener('click', () => callbacks.onChangeNumber());

  const codeFatal = el('div', 'zd-reset');
  codeFatal.style.display = 'none';
  const codeFatalText = el('p', 'zd-banner');
  const { button: codeFatalButton } = iconButton('Neue Demo anfordern', null);
  codeFatalButton.type = 'button';
  codeFatal.append(codeFatalText, codeFatalButton);
  let fatalHandler: (() => void) | null = null;
  codeFatalButton.addEventListener('click', () => fatalHandler?.());

  codeView.append(
    badge('message', 22),
    el('div', 'zd-center-title', 'Bestätige deine Nummer'),
    codeText,
    codeForm,
    codeActions,
    codeFatal
  );
  let codePhone = '';
  const describeChannel = (): void => {
    codeText.textContent =
      codeChannel === 'sms'
        ? `Wir haben dir eine SMS mit einem Code an ${codePhone} geschickt. Gib ihn hier ein – dann ruft dich der Agent sofort an.`
        : `Du bekommst gleich einen Anruf an ${codePhone}, der dir einen Code ansagt. Gib ihn hier ein – dann ruft dich der Agent sofort an.`;
    // landlines cannot receive SMS: "erneut senden" means another call there
    callButton.style.display = codeChannel === 'sms' ? '' : 'none';
  };

  // --- success view ------------------------------------------------------------
  const successView = el('div', 'zd-center');
  successView.style.display = 'none';
  const successText = el('p', 'zd-center-text');
  const status = el('div', 'zd-status');
  status.setAttribute('aria-live', 'polite');
  const dot = el('span', 'zd-dot');
  const statusText = el('span');
  status.append(dot, statusText);
  const resetWrap = el('div', 'zd-reset');
  const { button: resetButton } = iconButton('Neue Demo anfordern', null);
  resetButton.type = 'button';
  resetWrap.appendChild(resetButton);
  resetWrap.style.display = 'none';
  successView.append(
    badge('check', 22),
    el('div', 'zd-center-title', 'Nummer bestätigt!'),
    successText,
    status,
    resetWrap
  );
  let resetHandler: (() => void) | null = null;
  resetButton.addEventListener('click', () => resetHandler?.());

  container.append(formView, codeView, successView);

  const controls: Record<Exclude<DemoFieldKey, 'consent'>, Control> = {
    company,
    contactName,
    email,
    phone,
    websiteUrl,
    prompt,
  };

  const handles: DemoRenderHandles = {
    readValues() {
      return {
        company: company.input.value.trim(),
        contactName: contactName.input.value.trim(),
        email: email.input.value.trim(),
        phone: phone.input.value.trim(),
        websiteUrl: websiteUrl.input.value.trim(),
        prompt: prompt.input.value.trim(),
        consent: consentInput.checked,
        nickname: honeypot.value,
      };
    },
    validate() {
      const values = handles.readValues();
      const errors: DemoFieldErrors = {};
      if (!values.company) errors.company = 'Bitte ausfüllen.';
      if (!values.contactName) errors.contactName = 'Bitte ausfüllen.';
      if (!values.email) errors.email = 'Bitte ausfüllen.';
      else if (!EMAIL_PATTERN.test(values.email)) {
        errors.email = 'Bitte eine gültige E-Mail-Adresse angeben.';
      }
      if (!values.phone) errors.phone = 'Bitte ausfüllen.';
      if (!values.consent) errors.consent = 'Bitte stimme zu, um fortzufahren.';
      handles.setFieldErrors(errors);
      return Object.keys(errors).length === 0;
    },
    setFieldErrors(errors) {
      let firstInvalid: HTMLElement | null = null;
      for (const [key, control] of Object.entries(controls) as [
        Exclude<DemoFieldKey, 'consent'>,
        Control,
      ][]) {
        const message = errors[key] ?? null;
        control.setError(message);
        if (message && !firstInvalid) firstInvalid = control.input;
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
    showCodeStep(phone, channel) {
      // non-breaking spaces: the masked number never wraps mid-way
      codePhone = phone.replace(/ /g, '\u00a0');
      codeChannel = channel;
      describeChannel();
      codeInput.value = '';
      codeInput.disabled = false;
      handles.setCodeError(null);
      handles.setCodeInfo(null);
      handles.setVerifying(false);
      codeForm.style.display = 'block';
      codeActions.style.display = 'flex';
      codeFatal.style.display = 'none';
      formView.style.display = 'none';
      successView.style.display = 'none';
      codeView.style.display = 'block';
      codeInput.focus();
    },
    setCodeChannel(channel) {
      codeChannel = channel;
      describeChannel();
    },
    readCode() {
      return codeInput.value.replace(/\s+/g, '');
    },
    setCodeError(text) {
      codeError.textContent = text ?? '';
      codeError.style.display = text ? 'block' : 'none';
      codeInput.setAttribute('aria-invalid', text ? 'true' : 'false');
      if (text) codeInput.focus();
    },
    setCodeInfo(text) {
      codeInfo.textContent = text ?? '';
    },
    setVerifying(verifying) {
      verifyButton.disabled = verifying;
      verifyLabel.textContent = verifying ? 'Wird geprüft …' : VERIFY_LABEL;
    },
    setResendState({ secondsLeft, exhausted }) {
      const waiting = secondsLeft > 0;
      resendButton.style.display = exhausted ? 'none' : '';
      callButton.style.display = exhausted || codeChannel !== 'sms' ? 'none' : '';
      resendButton.disabled = waiting;
      callButton.disabled = waiting;
      resendButton.textContent = waiting
        ? `Code erneut senden (${secondsLeft} s)`
        : 'Code erneut senden';
    },
    showCodeFatal(text, onReset) {
      fatalHandler = onReset;
      codeFatalText.textContent = text;
      codeForm.style.display = 'none';
      codeActions.style.display = 'none';
      codeFatal.style.display = 'block';
    },
    showForm() {
      codeView.style.display = 'none';
      successView.style.display = 'none';
      formView.style.display = 'block';
      handles.setSubmitting(false);
      phone.input.focus();
    },
    showSuccess() {
      successText.textContent =
        'Der Agent ruft dich gleich an – halt dein Telefon bereit.';
      formView.style.display = 'none';
      codeView.style.display = 'none';
      successView.style.display = 'block';
    },
    setStatus(text, live) {
      statusText.textContent = text;
      dot.className = live ? 'zd-dot zd-dot--live' : 'zd-dot';
    },
    setReset(onReset) {
      resetHandler = onReset;
      resetWrap.style.display = onReset ? 'block' : 'none';
    },
    showEmptyForm() {
      form.reset();
      counter.textContent = `0/${PROMPT_MAX}`;
      handles.setFieldErrors({});
      handles.showBanner(null);
      handles.setSubmitting(false);
      handles.setReset(null);
      successView.style.display = 'none';
      codeView.style.display = 'none';
      formView.style.display = 'block';
    },
  };
  return handles;
}
