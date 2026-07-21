'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormDefinition, FormField, FormFieldType } from '@zendori/channels';
import { renderForm, buttonTextColor, type RenderHandles } from '@/form-embed/render';
import type { PublicFormDefinition } from '@/form-embed/types';
import {
  deleteForm,
  saveFormDefinition,
  updateFormNotificationSettings,
} from '@/app/settings/forms/actions';

/**
 * The form builder (Phase 10): field list with inline accordion editor +
 * design tab + embed tab + owner-only forwarding tab, next to a sticky live
 * preview that mounts the EXACT production renderer (form-embed/render) in a
 * shadow root — the preview cannot drift from what customer sites show.
 * v1 interaction model: ↑/↓ buttons instead of drag & drop (3–8 fields,
 * keyboard-accessible, no dependency).
 */

type TabKey = 'fields' | 'design' | 'embed' | 'forwarding';

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
}) {
  const [name, setName] = useState(props.initialName);
  const [definition, setDefinition] = useState<FormDefinition>(props.initialDefinition);
  const [tab, setTab] = useState<TabKey>('fields');
  const [openField, setOpenField] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [previewMobile, setPreviewMobile] = useState(false);
  const [previewSuccess, setPreviewSuccess] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState('');

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
  ];

  return (
    <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* ---------- editor column ---------- */}
      <div style={{ flex: '1 1 26rem', minWidth: 'min(22rem, 100%)', maxWidth: '34rem' }}>
        <div className="panel">
          <div>
            <label htmlFor="fb-name">Formular-Name</label>
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
          </div>

          <div className="tabbar" style={{ marginTop: '1rem' }}>
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`tab${tab === t.key ? ' tab--active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* ---------- fields tab ---------- */}
          {tab === 'fields' ? (
            <div>
              {!hasContactRole ? (
                <p className="notice" style={{ fontSize: '0.82rem' }}>
                  Ohne ein Feld mit Zuordnung „E-Mail des Kontakts" (oder Telefon) kann niemand
                  antworten — die Zuordnung findest du im Feld-Editor.
                </p>
              ) : null}
              {!hasConsentField ? (
                <p className="notice" style={{ fontSize: '0.82rem' }}>
                  ⚠️ Ohne Zustimmungs-Feld fehlt der DSGVO-Einwilligungsnachweis für die
                  Verarbeitung der Angaben.
                </p>
              ) : null}
              {definition.fields.map((field, index) => (
                <div
                  key={field.key}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: '10px',
                    marginBottom: '0.55rem',
                    background: 'var(--surface)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.55rem 0.7rem',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setOpenField(openField === field.key ? null : field.key)}
                      aria-expanded={openField === field.key}
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        font: 'inherit',
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          color: 'var(--text-muted)',
                          border: '1px solid var(--border)',
                          borderRadius: '6px',
                          padding: '0.1rem 0.4rem',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {TYPE_LABELS[field.type]}
                      </span>
                      <span
                        style={{
                          fontWeight: 600,
                          fontSize: '0.9rem',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {field.label}
                      </span>
                      {field.required ? (
                        <span style={{ color: 'var(--brand-600, #0895a1)' }}>*</span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="ghost ghost--icon"
                      aria-label={`Feld „${field.label}" nach oben`}
                      disabled={index === 0}
                      onClick={() => moveField(field.key, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="ghost ghost--icon"
                      aria-label={`Feld „${field.label}" nach unten`}
                      disabled={index === definition.fields.length - 1}
                      onClick={() => moveField(field.key, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="ghost ghost--icon"
                      aria-label={`Feld „${field.label}" duplizieren`}
                      onClick={() => duplicateField(field.key)}
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      className="ghost ghost--icon"
                      aria-label={`Feld „${field.label}" löschen`}
                      disabled={definition.fields.length <= 1}
                      onClick={() => removeField(field.key)}
                    >
                      ✕
                    </button>
                  </div>

                  {openField === field.key ? (
                    <div
                      className="stack"
                      style={{ padding: '0 0.7rem 0.7rem', borderTop: '1px solid var(--border)' }}
                    >
                      <div style={{ marginTop: '0.6rem' }}>
                        <label htmlFor={`fb-label-${field.key}`}>Beschriftung</label>
                        <input
                          id={`fb-label-${field.key}`}
                          type="text"
                          value={field.label}
                          maxLength={200}
                          onChange={(e) => updateField(field.key, { label: e.target.value })}
                        />
                      </div>
                      {field.type !== 'checkbox' && field.type !== 'consent' ? (
                        <div>
                          <label htmlFor={`fb-ph-${field.key}`}>Platzhalter (optional)</label>
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
                        </div>
                      ) : null}
                      {field.type === 'select' || field.type === 'radio' ? (
                        <div>
                          <label htmlFor={`fb-opt-${field.key}`}>
                            Optionen (eine pro Zeile)
                          </label>
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
                        </div>
                      ) : null}
                      {field.type === 'consent' ? (
                        <div>
                          <label htmlFor={`fb-consent-${field.key}`}>Zustimmungstext</label>
                          <textarea
                            id={`fb-consent-${field.key}`}
                            rows={3}
                            maxLength={1000}
                            value={field.consentText ?? ''}
                            onChange={(e) =>
                              updateField(field.key, { consentText: e.target.value })
                            }
                          />
                        </div>
                      ) : null}
                      {field.type !== 'consent' ? (
                        <label className="check-row" style={{ marginBottom: 0 }}>
                          <input
                            type="checkbox"
                            checked={field.required}
                            onChange={(e) => updateField(field.key, { required: e.target.checked })}
                          />
                          Pflichtfeld
                        </label>
                      ) : (
                        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                          Zustimmungs-Felder sind immer Pflicht (Einwilligungsnachweis).
                        </p>
                      )}
                      {['text', 'email', 'phone', 'textarea'].includes(field.type) ? (
                        <div>
                          <label htmlFor={`fb-role-${field.key}`}>Zuordnung</label>
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
                          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                            Zugeordnete Felder füllen Kontakt und Ticket automatisch.
                          </p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}

              <div style={{ marginTop: '0.9rem' }}>
                <span className="field-label">Feld hinzufügen</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.4rem' }}>
                  {FIELD_PALETTE.map((entry) => (
                    <button
                      key={entry.type}
                      type="button"
                      className="ghost"
                      onClick={() => addField(entry.type)}
                      disabled={definition.fields.length >= 30}
                    >
                      + {entry.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {/* ---------- design tab ---------- */}
          {tab === 'design' ? (
            <div className="stack">
              <div>
                <label htmlFor="fb-color">Primärfarbe</label>
                <input
                  id="fb-color"
                  type="color"
                  value={definition.design.color}
                  onChange={(e) =>
                    update({ ...definition, design: { ...definition.design, color: e.target.value } })
                  }
                />
                {whiteTextContrastLow ? (
                  <p className="notice" style={{ fontSize: '0.8rem', marginTop: '0.3rem' }}>
                    Helle Farbe erkannt — der Buttontext wird automatisch dunkel dargestellt.
                  </p>
                ) : null}
              </div>
              <div>
                <label htmlFor="fb-radius">Eckenradius</label>
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
              </div>
              <div>
                <label htmlFor="fb-submit">Button-Text</label>
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
              </div>
              <div>
                <label htmlFor="fb-title">Titel (optional)</label>
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
              </div>
              <div>
                <label htmlFor="fb-intro">Einleitung (optional)</label>
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
              </div>
              <div>
                <label htmlFor="fb-success">Erfolgsmeldung</label>
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
              </div>
              <div>
                <label htmlFor="fb-privacy">Datenschutz-URL (optional)</label>
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
              </div>
            </div>
          ) : null}

          {/* ---------- embed tab ---------- */}
          {tab === 'embed' ? (
            <div className="stack">
              <div>
                <span className="field-label">Script-Embed (empfohlen)</span>
                <code className="invite-link" style={{ whiteSpace: 'pre-wrap' }}>
                  {scriptSnippet}
                </code>
                <p className="hint">
                  Das div bestimmt die Position im Layout. Der Token ist öffentlich — er
                  identifiziert nur das Formular und enthält keine Geheimnisse.
                </p>
              </div>
              <div>
                <span className="field-label">Gehosteter Link</span>
                <code className="invite-link">{hostedUrl}</code>
                <p className="hint">
                  Für E-Mail-Signaturen, QR-Codes — und zum Testen:{' '}
                  <a href={hostedUrl} target="_blank" rel="noopener">
                    Formular testen ↗
                  </a>
                </p>
              </div>
              <div>
                <span className="field-label">iframe (Fallback, feste Höhe)</span>
                <code className="invite-link" style={{ whiteSpace: 'pre-wrap' }}>
                  {iframeSnippet}
                </code>
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Testeinsendungen erscheinen als ganz normale Konversationen in der Inbox.
                Speichern wirkt sofort auf eingebettete Formulare.
              </p>
            </div>
          ) : null}

          {/* ---------- forwarding tab (owner-only, separate server action) ----------
               kept MOUNTED and only hidden: its inputs are uncontrolled, a
               conditional render would silently discard typed recipients on
               every tab switch */}
          <div style={{ display: tab === 'forwarding' ? 'block' : 'none' }}>
            <div>
              <form className="stack" action={updateFormNotificationSettings}>
                <input type="hidden" name="org" value={props.orgId} />
                <input type="hidden" name="formId" value={props.formId} />
                <div>
                  <label htmlFor="fb-emails">Weiterleitung an E-Mail-Adressen (eine pro Zeile, max. 10)</label>
                  <textarea
                    id="fb-emails"
                    name="emails"
                    rows={4}
                    defaultValue={props.notificationEmails.join('\n')}
                    disabled={!props.isOwner}
                    placeholder={'info@firma.de\nvertrieb@firma.de'}
                  />
                  <p className="hint">
                    Jede Einsendung wird als gestaltete E-Mail an diese Adressen geschickt.
                    Antworten auf diese E-Mail gehen direkt an die einsendende Person (an Zendori
                    vorbei) — nachverfolgbare Antworten kommen aus der Inbox.
                  </p>
                </div>
                <div>
                  <label htmlFor="fb-cap">Tageslimit für Einsendungen</label>
                  <input
                    id="fb-cap"
                    name="dailyLimit"
                    type="number"
                    min={1}
                    max={10000}
                    defaultValue={props.dailyLimit}
                    disabled={!props.isOwner}
                  />
                  <p className="hint">
                    Schutz vor Spam-Fluten: darüber hinausgehende Einsendungen werden abgewiesen.
                  </p>
                </div>
                <button className="primary" type="submit" disabled={!props.isOwner}>
                  Weiterleitung speichern
                </button>
                {!props.isOwner ? (
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Nur Inhaber können Weiterleitung und Limits ändern.
                  </p>
                ) : null}
              </form>

            </div>
          </div>

          {/* ---------- save (definition + name) ---------- */}
          {tab === 'fields' || tab === 'design' ? (
            <form
              action={saveFormDefinition}
              style={{ marginTop: '1.1rem', display: 'flex', gap: '0.6rem', alignItems: 'center' }}
              onSubmit={() => setDirty(false)}
            >
              <input type="hidden" name="org" value={props.orgId} />
              <input type="hidden" name="formId" value={props.formId} />
              <input type="hidden" name="name" value={name} />
              <input type="hidden" name="definition" value={serialized} />
              <button className="primary" type="submit">
                Formular speichern
              </button>
              {dirty ? (
                <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                  Ungespeicherte Änderungen
                </span>
              ) : null}
            </form>
          ) : null}
        </div>

        {/* ---------- danger zone: always visible, DangerDeleteKb-style arm flow ---------- */}
        {props.isOwner ? (
          <div className="panel" style={{ borderColor: 'var(--danger-border)' }}>
            <span className="field-label" style={{ color: 'var(--danger)' }}>
              Formular löschen
            </span>
            <p className="hint" style={{ margin: '0.3rem 0 0.6rem' }}>
              Löscht das Formular UND alle zugehörigen Konversationen unwiderruflich. Zum
              Bestätigen den Formular-Namen eintippen.
            </p>
            <form
              action={deleteForm}
              style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}
            >
              <input type="hidden" name="org" value={props.orgId} />
              <input type="hidden" name="formId" value={props.formId} />
              <input
                type="text"
                placeholder={props.initialName}
                value={confirmDelete}
                onChange={(e) => setConfirmDelete(e.target.value)}
                style={{ maxWidth: '16rem' }}
              />
              <button
                className="danger"
                type="submit"
                disabled={confirmDelete !== props.initialName}
              >
                Endgültig löschen
              </button>
              {confirmDelete.length > 0 ? (
                <button className="ghost" type="button" onClick={() => setConfirmDelete('')}>
                  Abbrechen
                </button>
              ) : null}
            </form>
          </div>
        ) : null}
      </div>

      {/* ---------- preview column ---------- */}
      <div style={{ flex: '1 1 24rem', minWidth: 'min(20rem, 100%)', position: 'sticky', top: '1rem' }}>
        <div className="panel">
          <div
            style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.8rem' }}
          >
            <span className="field-label" style={{ flex: 1 }}>
              Live-Vorschau
            </span>
            <div className="tabbar" style={{ margin: 0 }}>
              <button
                type="button"
                className={`tab${previewMobile ? '' : ' tab--active'}`}
                onClick={() => setPreviewMobile(false)}
              >
                Desktop
              </button>
              <button
                type="button"
                className={`tab${previewMobile ? ' tab--active' : ''}`}
                onClick={() => setPreviewMobile(true)}
              >
                Mobil
              </button>
              <button
                type="button"
                className={`tab${previewSuccess ? ' tab--active' : ''}`}
                onClick={() => setPreviewSuccess(!previewSuccess)}
              >
                Erfolg
              </button>
            </div>
          </div>
          <div
            style={{
              margin: '0 auto',
              width: previewMobile ? '375px' : '100%',
              maxWidth: '100%',
              border: '1px dashed var(--border)',
              borderRadius: '12px',
              padding: '1rem',
              background: '#ffffff',
            }}
          >
            <div ref={previewHostRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
