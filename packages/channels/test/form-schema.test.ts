import { describe, expect, it } from 'vitest';
import {
  defaultFormDefinition,
  formDefinitionSchema,
  publicDefinition,
  roleValue,
  serializeSubmission,
  submissionSnapshot,
  validateSubmission,
  type FormDefinition,
} from '../src/form/schema.js';

function definitionWith(fields: unknown[]): FormDefinition {
  return formDefinitionSchema.parse({ fields });
}

const BASE = definitionWith([
  { key: 'f_name', type: 'text', label: 'Name', role: 'name' },
  { key: 'f_email', type: 'email', label: 'E-Mail', role: 'email', required: true },
  { key: 'f_topic', type: 'select', label: 'Thema', options: ['Angebot', 'Support'] },
  { key: 'f_msg', type: 'textarea', label: 'Nachricht', role: 'message', required: true },
  { key: 'f_consent', type: 'consent', label: 'Datenschutz', required: true, consentText: 'Ich stimme zu.' },
]);

describe('formDefinitionSchema', () => {
  it('parses the default definition with defaults applied', () => {
    const def = defaultFormDefinition();
    expect(def.design.color).toBe('#0bb8ba');
    expect(def.design.submitLabel).toBe('Absenden');
    expect(def.fields.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects duplicate field keys', () => {
    const result = formDefinitionSchema.safeParse({
      fields: [
        { key: 'a', type: 'text', label: 'A' },
        { key: 'a', type: 'text', label: 'B' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid keys and empty field lists', () => {
    expect(
      formDefinitionSchema.safeParse({ fields: [{ key: 'Bad-Key', type: 'text', label: 'x' }] })
        .success
    ).toBe(false);
    expect(formDefinitionSchema.safeParse({ fields: [] }).success).toBe(false);
  });

  it('rejects select/radio without options (unsubmittable form)', () => {
    expect(
      formDefinitionSchema.safeParse({
        fields: [{ key: 'f_sel', type: 'select', label: 'Auswahl', required: true, options: [] }],
      }).success
    ).toBe(false);
  });

  it('restricts privacyPolicyUrl to http(s) — javascript:/data: are stored XSS', () => {
    const fields = [{ key: 'f_email', type: 'email', label: 'E-Mail' }];
    expect(
      formDefinitionSchema.safeParse({ fields, privacyPolicyUrl: 'https://firma.de/datenschutz' })
        .success
    ).toBe(true);
    expect(
      formDefinitionSchema.safeParse({ fields, privacyPolicyUrl: 'javascript:alert(1)' }).success
    ).toBe(false);
    expect(
      formDefinitionSchema.safeParse({ fields, privacyPolicyUrl: 'data:text/html,<h1>x</h1>' })
        .success
    ).toBe(false);
  });
});

describe('validateSubmission', () => {
  it('accepts a complete valid submission', () => {
    const result = validateSubmission(BASE, {
      f_name: 'Max Muster',
      f_email: 'max@example.com',
      f_topic: 'Angebot',
      f_msg: 'Hallo, ich brauche ein Angebot.',
      f_consent: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.f_email).toBe('max@example.com');
      expect(result.values.f_consent).toBe(true);
    }
  });

  it('rejects missing required fields, missing consent and unknown keys', () => {
    const missing = validateSubmission(BASE, { f_email: 'max@example.com' });
    expect(missing.ok).toBe(false);

    const noConsent = validateSubmission(BASE, {
      f_email: 'max@example.com',
      f_msg: 'Hi',
      f_consent: false,
    });
    expect(noConsent.ok).toBe(false);

    const unknown = validateSubmission(BASE, {
      f_email: 'max@example.com',
      f_msg: 'Hi',
      f_consent: true,
      evil_extra: 'payload',
    });
    expect(unknown.ok).toBe(false);
  });

  it('enforces the select whitelist, e-mail format and length caps', () => {
    const badOption = validateSubmission(BASE, {
      f_email: 'max@example.com',
      f_topic: 'Nicht-Option',
      f_msg: 'Hi',
      f_consent: true,
    });
    expect(badOption.ok).toBe(false);

    const badEmail = validateSubmission(BASE, {
      f_email: 'keine-mail',
      f_msg: 'Hi',
      f_consent: true,
    });
    expect(badEmail.ok).toBe(false);

    const tooLong = validateSubmission(BASE, {
      f_email: 'max@example.com',
      f_name: 'x'.repeat(501),
      f_msg: 'Hi',
      f_consent: true,
    });
    expect(tooLong.ok).toBe(false);
  });
});

describe('roleValue / serializeSubmission / snapshot', () => {
  const values = {
    f_name: 'Max Muster',
    f_email: 'max@example.com',
    f_msg: 'Zeile 1\nZeile 2',
    f_consent: true as const,
  };

  it('resolves role values', () => {
    expect(roleValue(BASE, values, 'email')).toBe('max@example.com');
    expect(roleValue(BASE, values, 'phone')).toBeNull();
  });

  it('serializes as "Label: Wert" lines (looksLikeForm-compatible)', () => {
    const text = serializeSubmission(BASE, values);
    expect(text).toContain('Name: Max Muster');
    expect(text).toContain('E-Mail: max@example.com');
    expect(text).toContain('Datenschutz: Ja');
    // at least two "Label: value" lines → worker looksLikeForm() triggers
    expect(text.split('\n').filter((l) => /^[^:]{1,30}: .+/.test(l)).length).toBeGreaterThanOrEqual(2);
  });

  it('builds a self-contained snapshot incl. consent proof', () => {
    const snapshot = submissionSnapshot({
      formId: '00000000-0000-0000-0000-000000000001',
      version: 3,
      definition: BASE,
      values,
      now: new Date('2026-07-21T10:00:00Z'),
    });
    expect(snapshot.version).toBe(3);
    expect(snapshot.contact_authoritative).toBe(true);
    const consent = snapshot.consent as { text: string; accepted_at: string };
    expect(consent.text).toBe('Ich stimme zu.');
    expect(consent.accepted_at).toBe('2026-07-21T10:00:00.000Z');
    const fields = snapshot.fields as { label: string; value: string }[];
    expect(fields.find((f) => f.label === 'Datenschutz')?.value).toBe('Ja');
  });

  it('publicDefinition strips the role mapping', () => {
    const pub = publicDefinition(BASE) as { fields: Record<string, unknown>[] };
    expect(pub.fields.every((f) => !('role' in f))).toBe(true);
  });
});
