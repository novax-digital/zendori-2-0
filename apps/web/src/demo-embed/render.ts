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
const SUBMIT_LABEL = 'Demo-Anruf anfordern';
const INTRO =
  'Geben Sie Ihre Daten ein – unser KI-Telefonassistent ruft Sie gleich im Namen Ihres Unternehmens an. Zur Sicherheit bestätigen Sie Ihre Nummer vorher mit einem Code per SMS.';
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
  }
): Control {
  const wrap = el('div', 'zd-field');
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
  container.style.setProperty('--zd-accent', options.accent);
  container.style.setProperty('--zd-accent-text', buttonTextColor(options.accent));
  root.appendChild(container);

  const idPrefix = `zd${Math.floor(Math.random() * 1e6)}`;

  // --- form view ---------------------------------------------------------------
  const formView = el('div');
  formView.append(el('div', 'zd-title', options.title), el('p', 'zd-intro', INTRO));
  const banner = el('div', 'zd-banner');
  banner.style.display = 'none';
  banner.setAttribute('role', 'alert');
  formView.appendChild(banner);

  const form = el('form');
  form.noValidate = true;
  formView.appendChild(form);

  const company = textControl(idPrefix, 'company', 'Unternehmen', {
    required: true,
    autocomplete: 'organization',
  });
  const contactName = textControl(idPrefix, 'contactName', 'Ihr Name', {
    required: true,
    autocomplete: 'name',
  });
  const email = textControl(idPrefix, 'email', 'Geschäftliche E-Mail', {
    required: true,
    type: 'email',
    autocomplete: 'email',
  });
  const phone = textControl(idPrefix, 'phone', 'Telefonnummer', {
    required: true,
    type: 'tel',
    autocomplete: 'tel',
    hint: 'Deutsche Mobil- oder Festnetznummer, z. B. 0170 1234567',
  });
  const websiteUrl = textControl(idPrefix, 'websiteUrl', 'Website', {
    required: false,
    autocomplete: 'url',
    placeholder: 'www.ihre-firma.de',
    hint: 'Optional – der Assistent liest Ihre Startseite und kennt dann Ihr Angebot.',
  });
  const prompt = textControl(idPrefix, 'prompt', 'Was soll der Assistent im Anruf tun?', {
    required: false,
    multiline: true,
    placeholder:
      'z. B. Ruf mich als Kunde an, der einen Termin für eine Heizungswartung vereinbaren möchte, und frag nach meiner Adresse.',
  });
  const counter = el('div', 'zd-counter', `0/${PROMPT_MAX}`);
  prompt.input.after(counter);
  prompt.input.addEventListener('input', () => {
    counter.textContent = `${prompt.input.value.length}/${PROMPT_MAX}`;
  });

  const rowOne = el('div', 'zd-row');
  rowOne.append(company.wrap, contactName.wrap);
  const rowTwo = el('div', 'zd-row');
  rowTwo.append(email.wrap, phone.wrap);
  form.append(rowOne, rowTwo, websiteUrl.wrap, prompt.wrap);

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
  const submit = el('button', 'zd-button', SUBMIT_LABEL);
  submit.type = 'submit';
  form.appendChild(submit);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    callbacks.onSubmit();
  });

  // --- code view (phone verification) --------------------------------------------
  const codeView = el('div', 'zd-code');
  codeView.style.display = 'none';
  const codeText = el('p', 'zd-success-text');
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
  const verifyButton = el('button', 'zd-button', VERIFY_LABEL);
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
  const codeFatalButton = el('button', 'zd-button', 'Neue Demo anfordern');
  codeFatalButton.type = 'button';
  codeFatal.append(codeFatalText, codeFatalButton);
  let fatalHandler: (() => void) | null = null;
  codeFatalButton.addEventListener('click', () => fatalHandler?.());

  codeView.append(
    el('div', 'zd-success-icon', '✉'),
    el('div', 'zd-success-title', 'Bestätigen Sie Ihre Nummer'),
    codeText,
    codeForm,
    codeActions,
    codeFatal
  );
  let codePhone = '';
  const describeChannel = (): void => {
    codeText.textContent =
      codeChannel === 'sms'
        ? `Wir haben Ihnen eine SMS mit einem Code an ${codePhone} geschickt. Geben Sie ihn hier ein – dann ruft Sie der Assistent sofort an.`
        : `Sie erhalten gleich einen Anruf an ${codePhone}, der Ihnen einen Code ansagt. Geben Sie ihn hier ein – dann ruft Sie der Assistent sofort an.`;
    // landlines cannot receive SMS: "erneut senden" means another call there
    callButton.style.display = codeChannel === 'sms' ? '' : 'none';
  };

  // --- success view ------------------------------------------------------------
  const successView = el('div', 'zd-success');
  successView.style.display = 'none';
  const successText = el('p', 'zd-success-text');
  const status = el('div', 'zd-status');
  status.setAttribute('aria-live', 'polite');
  const dot = el('span', 'zd-dot');
  const statusText = el('span');
  status.append(dot, statusText);
  const resetWrap = el('div', 'zd-reset');
  const resetButton = el('button', 'zd-button', 'Neue Demo anfordern');
  resetButton.type = 'button';
  resetWrap.appendChild(resetButton);
  resetWrap.style.display = 'none';
  successView.append(
    el('div', 'zd-success-icon', '✓'),
    el('div', 'zd-success-title', 'Nummer bestätigt!'),
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
      if (!values.consent) errors.consent = 'Bitte stimmen Sie zu, um fortzufahren.';
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
      submit.textContent = submitting ? 'Wird gesendet …' : SUBMIT_LABEL;
    },
    showBanner(text) {
      banner.textContent = text ?? '';
      banner.style.display = text ? 'block' : 'none';
    },
    showCodeStep(phone, channel) {
      codePhone = phone;
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
      verifyButton.textContent = verifying ? 'Wird geprüft …' : VERIFY_LABEL;
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
        'Der Assistent ruft Sie gleich an – halten Sie Ihr Telefon bereit.';
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
