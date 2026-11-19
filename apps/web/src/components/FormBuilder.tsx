'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FormDefinition, FormField, FormFieldType } from '@zendori/channels';
import { renderForm, buttonTextColor, type RenderHandles } from '@/form-embed/render';
import type { PublicFormDefinition } from '@/form-embed/types';
import { saveFormDefinition, updateFormNotificationSettings } from '@/app/settings/forms/actions';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { Field, SettingRow } from '@/components/ui/Field';
import Icon from '@/components/ui/Icon';
import { CodeBlock, Section } from '@/components/ui/Layout';

/**
 * The form builder (Phase 10): field list with inline accordion editor +
 * design tab + embed tab + owner-only forwarding tab, next to a sticky live
 * preview that mounts the EXACT production renderer (form-embed/render) in a
 * shadow root — the preview cannot drift from what customer sites show.
 * v1 interaction model: up/down buttons instead of drag & drop (3–8 fields,
 * keyboard-accessible, no dependency).
 *
 * Redesign (docs/design-redesign.md): rendered as direct children of the
 * page's `.page` — the tabs take over the page head's bottom line
 * (.page-tabs), the body keeps the two columns, saving sits in the save bar.
 * Deleting moved to the page head's menu (DeleteFormDrawer).
 *
 * A form is a channel type: the last tab shows the channel's own settings
 * (agent, active). They are server-rendered mini-forms with server actions, so
 * the page passes them in as a node (`channelSettings`).
 */

type TabKey = 'fields' | 'design' | 'embed' | 'forwarding' | 'channel';

const FIELD_PALETTE: { type: FormFieldType; label: string }[] = [
  { type: 'text', label: 'Text' },
  { type: 'email', label: 'E-Mail' },
  { type: 'phone', label: 'Telefon' },
  { type: 'textarea', label: 'Textbereich' },
  { type: 'select', label: 'Auswahl' },
  { type: 'radio', label: 'Optionsfelder' },
  { type: 'date', label: 'Datum' },
  { type: 'checkbox', label: 'Checkbox' },
  { type: 'consent', label: 'Zustimmung' },
];

const TYPE_LABELS: Record<FormFieldType, string> = {
  text: 'Text',
  email: 'E-Mail',
  phone: 'Telefon',
  textarea: 'Textbereich',
  select: 'Auswahl',
  radio: 'Optionsfelder',
  checkbox: 'Checkbox',
  date: 'Datum',
  consent: 'Zustimmung',
};

const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Keine Zuordnung' },
  { value: 'name', label: 'Name des Kontakts' },
  { value: 'email', label: 'E-Mail des Kontakts' },
  { value: 'phone', label: 'Telefon des Kontakts' },
  { value: 'subject', label: 'Betreff des Tickets' },
  { value: 'message', label: 'Anliegen / Nachricht' },
];

function newFieldKey(): string {
  return `f_${Math.random().toString(36).slice(2, 10)}`;
}

function defaultFieldFor(type: FormFieldType): FormField {
  const base: FormField = { key: newFieldKey(), type, label: TYPE_LABELS[type], required: false };
  if (type === 'select' || type === 'radio') base.options = ['Option 1', 'Option 2'];
  if (type === 'consent') {
    base.required = true;
    base.consentText =
      'Ich stimme zu, dass meine Angaben zur Bearbeitung meiner Anfrage verarbeitet werden.';
    base.label = 'Datenschutz';
  }
  if (type === 'email') base.role = 'email';
  return base;
}

export default function FormBuilder(props: {
  orgId: string;
  formId: string;
  initialName: string;
  initialDefinition: FormDefinition;
  publicToken: string;
  notificationEmails: string[];
  dailyLimit: number;
  isOwner: boolean;
  embedBase: string;
  /** Tab to open first (?tab=…); the builder's own state takes over afterwards. */
  initialTab?: TabKey;
  /** Agent + active rows of the form's channel; without them the tab is hidden. */
  channelSettings?: ReactNode;
  /** The page's ?notice= / ?error= banners, shown above both columns. */
  banners?: ReactNode;
}) {
  const [name, setName] = useState(props.initialName);
  const [definition, setDefinition] = useState<FormDefinition>(props.initialDefinition);
  const [tab, setTab] = useState<TabKey>(props.initialTab ?? 'fields');
  const [openField, setOpenField] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [previewMobile, setPreviewMobile] = useState(false);
  const [previewSuccess, setPreviewSuccess] = useState(false);

  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const previewHandles = useRef<RenderHandles | null>(null);

  const update = (next: FormDefinition): void => {
    setDefinition(next);
    setDirty(true);
  };
  const updateField = (key: string, patch: Partial<FormField>): void => {
    update({
      ...definition,
      fields: definition.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)),
    });
  };
  const moveField = (key: string, direction: -1 | 1): void => {
    const index = definition.fields.findIndex((f) => f.key === key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= definition.fields.length) return;
    const fields = [...definition.fields];
    const [moved] = fields.splice(index, 1);
    if (!moved) return;
    fields.splice(target, 0, moved);
    update({ ...definition, fields });
  };
  const removeField = (key: string): void => {
    if (definition.fields.length <= 1) return;
    update({ ...definition, fields: definition.fields.filter((f) => f.key !== key) });
  };
  const duplicateField = (key: string): void => {
    const index = definition.fields.findIndex((f) => f.key === key);
    const source = definition.fields[index];
    if (!source || definition.fields.length >= 30) return;
    const copy: FormField = { ...source, key: newFieldKey() };
    delete copy.role; // roles should stay unique — the copy starts unmapped
    const fields = [...definition.fields];
    fields.splice(index + 1, 0, copy);
    update({ ...definition, fields });
  };
  const addField = (type: FormFieldType): void => {
    if (definition.fields.length >= 30) return;
    const field = defaultFieldFor(type);
    update({ ...definition, fields: [...definition.fields, field] });
    setOpenField(field.key);
  };

  // --- live preview: production renderer in a shadow root ------------------------
  useEffect(() => {
    const host = previewHostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const raf = requestAnimationFrame(() => {
      previewHandles.current = renderForm(
        shadow,
        definition as unknown as PublicFormDefinition,
        { mode: 'preview' }
      );
      if (previewSuccess) previewHandles.current.showSuccess();
    });
    return () => cancelAnimationFrame(raf);
  }, [definition, previewSuccess]);

  // --- unsaved-changes guard ------------------------------------------------------
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const serialized = useMemo(() => JSON.stringify(definition), [definition]);
  // only ROLE-mapped fields fill the contact — an email-TYPE field without the
  // mapping still leaves the contact reply-less
  const hasContactRole = definition.fields.some(
    (f) => f.role === 'email' || f.role === 'phone'
  );
  const hasConsentField = definition.fields.some((f) => f.type === 'consent');
  const whiteTextContrastLow = buttonTextColor(definition.design.color) === '#0f172a';

  const scriptSnippet = `<div data-zendori-form="${props.publicToken}"></div>\n<script src="${props.embedBase}/form.js" async></script>`;
  const hostedUrl = `${props.embedBase}/f/${props.publicToken}`;
  const iframeSnippet = `<iframe src="${hostedUrl}" style="width:100%;max-width:680px;height:760px;border:0"></iframe>`;

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'fields', label: 'Felder' },
    { key: 'design', label: 'Design' },
    { key: 'embed', label: 'Einbetten' },
    { key: 'forwarding', label: 'Weiterleitung' },
    ...(props.channelSettings ? [{ key: 'channel' as const, label: 'Agent und Status' }] : []),
  ];
  const fieldLimitReached = definition.fields.length >= 30;

  return (
    <>
      {/* ---------- tabs: on the page head's bottom line ---------- */}
      <div className="page-tabs">
        <div className="tabs" role="tablist" aria-label="Bereiche des Formulars">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="page-body fb-body">
        {props.banners}

        {/* ---------- editor column ---------- */}
        <div className="fb-editor">
          {/* ---------- fields tab ---------- */}
          {tab === 'fields' ? (
            <div className="stack stack--lg">
              <Field label="Formular-Name" htmlFor="fb-name">
                <input
                  id="fb-name"
                  type="text"
                  value={name}
                  maxLength={120}
                  onChange={(e) => {
                    setName(e.target.value);
                    setDirty(true);
                  }}
                />
              </Field>

              {!hasContactRole || !hasConsentField ? (
                <div className="stack stack--sm">
                  {!hasContactRole ? (
                    <Callout tone="warn">
                      Ohne ein Feld mit Zuordnung „E-Mail des Kontakts“ (oder Telefon) kann niemand
                      antworten — die Zuordnung findest du im Feld-Editor.
                    </Callout>
                  ) : null}
                  {!hasConsentField ? (
                    <Callout tone="warn">
                      Ohne Zustimmungs-Feld fehlt der DSGVO-Einwilligungsnachweis für die
                      Verarbeitung der Angaben.
                    </Callout>
                  ) : null}
                </div>
              ) : null}

              <div className="stack stack--sm">
                {definition.fields.map((field, index) => {
                  const open = openField === field.key;
                  return (
                    <div key={field.key} className="fb-field">
                      <div className="fb-field-head">
                        <button
                          type="button"
                          className="fb-field-toggle"
                          onClick={() => setOpenField(open ? null : field.key)}
                          aria-expanded={open}
                        >
                          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
                          <Badge tone="muted">{TYPE_LABELS[field.type]}</Badge>
                          <span className="fb-field-label truncate">{field.label}</span>
                          {field.required ? <Badge tone="accent">Pflicht</Badge> : null}
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          iconOnly
                          icon="chevronDown"
                          className="fb-up"
                          aria-label={`Feld „${field.label}“ nach oben`}
                          disabled={index === 0}
                          onClick={() => moveField(field.key, -1)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          iconOnly
                          icon="chevronDown"
                          aria-label={`Feld „${field.label}“ nach unten`}
                          disabled={index === definition.fields.length - 1}
                          onClick={() => moveField(field.key, 1)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          iconOnly
                          icon="trash"
                          aria-label={`Feld „${field.label}“ löschen`}
                          disabled={definition.fields.length <= 1}
                          onClick={() => removeField(field.key)}
                        />
                      </div>

                      {open ? (
                        <div className="stack fb-field-body">
                          <Field label="Beschriftung" htmlFor={`fb-label-${field.key}`}>
                            <input
                              id={`fb-label-${field.key}`}
                              type="text"
                              value={field.label}
                              maxLength={200}
                              onChange={(e) => updateField(field.key, { label: e.target.value })}
                            />
                          </Field>
                          {field.type !== 'checkbox' && field.type !== 'consent' ? (
                            <Field label="Platzhalter (optional)" htmlFor={`fb-ph-${field.key}`}>
                              <input
                                id={`fb-ph-${field.key}`}
                                type="text"
                                value={field.placeholder ?? ''}
                                maxLength={200}
                                onChange={(e) =>
                                  updateField(field.key, {
                                    placeholder: e.target.value || undefined,
                                  })
                                }
                              />
                            </Field>
                          ) : null}
                          {field.type === 'select' || field.type === 'radio' ? (
                            <Field label="Optionen (eine pro Zeile)" htmlFor={`fb-opt-${field.key}`}>
                              <textarea
                                id={`fb-opt-${field.key}`}
                                rows={4}
                                value={(field.options ?? []).join('\n')}
                                onChange={(e) =>
                                  updateField(field.key, {
                                    options: e.target.value
                                      .split('\n')
                                      .map((o) => o.trim())
                                      .filter((o) => o.length > 0)
                                      .slice(0, 50),
                                  })
                                }
                              />
                            </Field>
                          ) : null}
                          {field.type === 'consent' ? (
                            <Field
                              label="Zustimmungstext"
                              htmlFor={`fb-consent-${field.key}`}
                              help="Zustimmungs-Felder sind immer Pflicht (Einwilligungsnachweis)."
                            >
                              <textarea
                                id={`fb-consent-${field.key}`}
                                rows={3}
                                maxLength={1000}
                                value={field.consentText ?? ''}
                                onChange={(e) =>
                                  updateField(field.key, { consentText: e.target.value })
                                }
                              />
                            </Field>
                          ) : null}
                          {['text', 'email', 'phone', 'textarea'].includes(field.type) ? (
                            <Field
                              label="Zuordnung"
                              htmlFor={`fb-role-${field.key}`}
                              help="Zugeordnete Felder füllen Kontakt und Ticket automatisch."
                            >
                              <select
                                id={`fb-role-${field.key}`}
                                value={field.role ?? ''}
                                onChange={(e) =>
                                  updateField(field.key, {
                                    role: (e.target.value || undefined) as FormField['role'],
                                  })
                                }
                              >
                                {ROLE_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </Field>
                          ) : null}
                          {field.type !== 'consent' ? (
                            <SettingRow label="Pflichtfeld" htmlFor={`fb-req-${field.key}`}>
                              <input
                                id={`fb-req-${field.key}`}
                                type="checkbox"
                                className="switch"
                                checked={field.required}
                                onChange={(e) =>
                                  updateField(field.key, { required: e.target.checked })
                                }
                              />
                            </SettingRow>
                          ) : null}
                          <div className="row">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              icon="plus"
                              disabled={fieldLimitReached}
                              onClick={() => duplicateField(field.key)}
                            >
                              Feld duplizieren
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="stack stack--sm">
                <span className="field-label">Feld hinzufügen</span>
                <div className="row">
                  {FIELD_PALETTE.map((entry) => (
                    <Button
                      key={entry.type}
                      type="button"
                      size="sm"
                      icon="plus"
                      onClick={() => addField(entry.type)}
                      disabled={fieldLimitReached}
                    >
                      {entry.label}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {/* ---------- design tab ---------- */}
          {tab === 'design' ? (
            <div className="stack">
              <Field label="Primärfarbe" htmlFor="fb-color">
                <input
                  id="fb-color"
                  type="color"
                  value={definition.design.color}
                  onChange={(e) =>
                    update({ ...definition, design: { ...definition.design, color: e.target.value } })
                  }
                />
              </Field>
              {whiteTextContrastLow ? (
                <Callout>
                  Helle Farbe erkannt — der Buttontext wird automatisch dunkel dargestellt.
                </Callout>
              ) : null}
              <Field label="Eckenradius" htmlFor="fb-radius">
                <select
                  id="fb-radius"
                  value={definition.design.radius}
                  onChange={(e) =>
                    update({
                      ...definition,
                      design: {
                        ...definition.design,
                        radius: e.target.value as FormDefinition['design']['radius'],
                      },
                    })
                  }
                >
                  <option value="square">Eckig</option>
                  <option value="rounded">Abgerundet</option>
                  <option value="pill">Pill-Button</option>
                </select>
              </Field>
              <Field label="Button-Text" htmlFor="fb-submit">
                <input
                  id="fb-submit"
                  type="text"
                  maxLength={60}
                  value={definition.design.submitLabel}
                  onChange={(e) =>
                    update({
                      ...definition,
                      design: { ...definition.design, submitLabel: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label="Titel (optional)" htmlFor="fb-title">
                <input
                  id="fb-title"
                  type="text"
                  maxLength={120}
                  value={definition.design.title ?? ''}
                  onChange={(e) =>
                    update({
                      ...definition,
                      design: { ...definition.design, title: e.target.value || undefined },
                    })
                  }
                />
              </Field>
              <Field label="Einleitung (optional)" htmlFor="fb-intro">
                <textarea
                  id="fb-intro"
                  rows={3}
                  maxLength={500}
                  value={definition.design.intro ?? ''}
                  onChange={(e) =>
                    update({
                      ...definition,
                      design: { ...definition.design, intro: e.target.value || undefined },
                    })
                  }
                />
              </Field>
              <Field label="Erfolgsmeldung" htmlFor="fb-success">
                <textarea
                  id="fb-success"
                  rows={3}
                  maxLength={500}
                  value={definition.design.successMessage}
                  onChange={(e) =>
                    update({
                      ...definition,
                      design: { ...definition.design, successMessage: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label="Datenschutz-URL (optional)" htmlFor="fb-privacy">
                <input
                  id="fb-privacy"
                  type="url"
                  maxLength={500}
                  placeholder="https://…/datenschutz"
                  value={definition.privacyPolicyUrl ?? ''}
                  onChange={(e) =>
                    update({ ...definition, privacyPolicyUrl: e.target.value || undefined })
                  }
                />
              </Field>
            </div>
          ) : null}

          {/* ---------- embed tab ---------- */}
          {tab === 'embed' ? (
            <div>
              <Section
                title="Script-Embed (empfohlen)"
                help="Das div bestimmt die Position im Layout. Der Token ist öffentlich — er identifiziert nur das Formular und enthält keine Geheimnisse."
              >
                <CodeBlock>{scriptSnippet}</CodeBlock>
              </Section>
              <Section
                title="Gehosteter Link"
                help="Für E-Mail-Signaturen, QR-Codes und zum Testen."
                actions={
                  <Button href={hostedUrl} size="sm" icon="external" target="_blank" rel="noopener">
                    Formular testen
                  </Button>
                }
              >
                <CodeBlock>{hostedUrl}</CodeBlock>
              </Section>
              <Section title="iframe (Fallback, feste Höhe)">
                <CodeBlock>{iframeSnippet}</CodeBlock>
              </Section>
              <p className="muted small page-note">
                Testeinsendungen erscheinen als ganz normale Konversationen in der Inbox. Speichern
                wirkt sofort auf eingebettete Formulare.
              </p>
            </div>
          ) : null}

          {/* ---------- forwarding tab (owner-only, separate server action) ----------
               kept MOUNTED and only hidden: its inputs are uncontrolled, a
               conditional render would silently discard typed recipients on
               every tab switch. Its submit button sits in the save bar and
               reaches the form through the `form` attribute. */}
          <div hidden={tab !== 'forwarding'}>
            <form id="fb-forwarding" className="stack" action={updateFormNotificationSettings}>
              <input type="hidden" name="org" value={props.orgId} />
              <input type="hidden" name="formId" value={props.formId} />
              {!props.isOwner ? (
                <Callout>Nur Inhaber können Weiterleitung und Limits ändern.</Callout>
              ) : null}
              <Field
                label="Weiterleitung an E-Mail-Adressen (eine pro Zeile, max. 10)"
                htmlFor="fb-emails"
                help="Jede Einsendung wird als gestaltete E-Mail an diese Adressen geschickt. Antworten auf diese E-Mail gehen direkt an die einsendende Person (an Zendori vorbei) — nachverfolgbare Antworten kommen aus der Inbox."
              >
                <textarea
                  id="fb-emails"
                  name="emails"
                  rows={4}
                  defaultValue={props.notificationEmails.join('\n')}
                  disabled={!props.isOwner}
                  placeholder={'info@firma.de\nvertrieb@firma.de'}
                />
              </Field>
              <Field
                label="Tageslimit für Einsendungen"
                htmlFor="fb-cap"
                help="Schutz vor Spam-Fluten: darüber hinausgehende Einsendungen werden abgewiesen."
              >
                <input
                  id="fb-cap"
                  name="dailyLimit"
                  type="number"
                  min={1}
                  max={10000}
                  defaultValue={props.dailyLimit}
                  disabled={!props.isOwner}
                />
              </Field>
            </form>
          </div>

          {/* ---------- channel tab: agent + active (own forms, own actions) ---------- */}
          {tab === 'channel' ? props.channelSettings : null}
        </div>

        {/* ---------- preview column ---------- */}
        <div className="fb-preview">
          <Section
            title="Live-Vorschau"
            actions={
              <div className="row" role="group" aria-label="Ansicht der Vorschau">
                <Button
                  type="button"
                  size="sm"
                  variant={previewMobile ? 'ghost' : 'secondary'}
                  aria-pressed={!previewMobile}
                  onClick={() => setPreviewMobile(false)}
                >
                  Desktop
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={previewMobile ? 'secondary' : 'ghost'}
                  aria-pressed={previewMobile}
                  onClick={() => setPreviewMobile(true)}
                >
                  Mobil
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={previewSuccess ? 'secondary' : 'ghost'}
                  aria-pressed={previewSuccess}
                  onClick={() => setPreviewSuccess(!previewSuccess)}
                >
                  Erfolg
                </Button>
              </div>
            }
          >
            <div className={`fb-preview-frame${previewMobile ? ' fb-preview-frame--mobile' : ''}`}>
              <div ref={previewHostRef} />
            </div>
          </Section>
        </div>
      </div>

      {/* ---------- save bar: definition + name (fields/design), forwarding ---------- */}
      {tab === 'fields' || tab === 'design' ? (
        <form className="save-bar" action={saveFormDefinition} onSubmit={() => setDirty(false)}>
          <input type="hidden" name="org" value={props.orgId} />
          <input type="hidden" name="formId" value={props.formId} />
          <input type="hidden" name="name" value={name} />
          <input type="hidden" name="definition" value={serialized} />
          <Button type="submit" variant="primary">
            Formular speichern
          </Button>
          {dirty ? <span className="muted small">Ungespeicherte Änderungen</span> : null}
        </form>
      ) : null}
      {tab === 'forwarding' ? (
        <div className="save-bar">
          <Button type="submit" form="fb-forwarding" variant="primary" disabled={!props.isOwner}>
            Weiterleitung speichern
          </Button>
        </div>
      ) : null}
    </>
  );
}
