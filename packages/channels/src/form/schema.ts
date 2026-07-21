import { z } from 'zod';

// Form-builder definition (Phase 10). ONE zod schema is the single source of
// truth for the builder UI, the public bootstrap payload, the submit-route
// validation and the worker (concept: the widget-config drift must not repeat).
// The definition lives in forms.definition (jsonb); every submission stores a
// full field snapshot in messages.metadata.form so old submissions stay
// interpretable after the form is edited (no form_versions table in v1).

export const FORM_FIELD_TYPES = [
  'text',
  'email',
  'phone',
  'textarea',
  'select',
  'radio',
  'checkbox',
  'date',
  'consent',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Semantic role → direct contact/conversation mapping without an AI hop. */
export const FORM_FIELD_ROLES = ['name', 'email', 'phone', 'subject', 'message'] as const;
export type FormFieldRole = (typeof FORM_FIELD_ROLES)[number];

export const formFieldSchema = z.object({
  /** Stable generated id — never derived from the label. */
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  type: z.enum(FORM_FIELD_TYPES),
  label: z.string().min(1).max(200),
  placeholder: z.string().max(200).optional(),
  required: z.boolean().default(false),
  /** select/radio option values (shown verbatim). */
  options: z.array(z.string().min(1).max(200)).max(50).optional(),
  role: z.enum(FORM_FIELD_ROLES).optional(),
  maxLength: z.number().int().positive().max(5000).optional(),
  /** consent only: the exact text the visitor agrees to (Art. 7 proof). */
  consentText: z.string().max(1000).optional(),
});
export type FormField = z.infer<typeof formFieldSchema>;

export const FORM_RADIUS_PRESETS = ['square', 'rounded', 'pill'] as const;

export const formDesignSchema = z.object({
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#0bb8ba'),
  radius: z.enum(FORM_RADIUS_PRESETS).default('rounded'),
  submitLabel: z.string().min(1).max(60).default('Absenden'),
  title: z.string().max(120).optional(),
  intro: z.string().max(500).optional(),
  successMessage: z
    .string()
    .min(1)
    .max(500)
    .default('Vielen Dank! Wir melden uns so schnell wie möglich.'),
});
export type FormDesign = z.infer<typeof formDesignSchema>;

export const formDefinitionSchema = z.object({
  fields: z
    .array(formFieldSchema)
    .min(1)
    .max(30)
    .superRefine((fields, ctx) => {
      const seen = new Set<string>();
      for (const field of fields) {
        if (seen.has(field.key)) {
          ctx.addIssue({ code: 'custom', message: `duplicate field key: ${field.key}` });
        }
        seen.add(field.key);
        // a select/radio without options is unsubmittable when required and
        // pointless otherwise — reject at save time, not at the visitor
        if (
          (field.type === 'select' || field.type === 'radio') &&
          (!field.options || field.options.length === 0)
        ) {
          ctx.addIssue({
            code: 'custom',
            message: `field ${field.key} (${field.type}) needs at least one option`,
          });
        }
      }
    }),
  design: formDesignSchema.default(formDesignSchema.parse({})),
  // http(s) only: z.url() alone accepts javascript:/data: — rendered as a raw
  // href on the public hosted page, that would be stored XSS on the app origin
  privacyPolicyUrl: z
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'nur http(s)-URLs')
    .optional(),
  locale: z.string().default('de'),
});
export type FormDefinition = z.infer<typeof formDefinitionSchema>;

/** Recipient list stored in forms.notification_emails. */
export const formNotificationEmailsSchema = z.array(z.email()).max(10);

export const DEFAULT_CONSENT_TEXT =
  'Ich stimme zu, dass meine Angaben zur Bearbeitung meiner Anfrage verarbeitet werden.';

/** Definition a freshly created form starts with (builder opens on this). */
export function defaultFormDefinition(): FormDefinition {
  return formDefinitionSchema.parse({
    fields: [
      { key: 'f_name', type: 'text', label: 'Name', role: 'name', required: false },
      { key: 'f_email', type: 'email', label: 'E-Mail', role: 'email', required: true },
      {
        key: 'f_message',
        type: 'textarea',
        label: 'Ihre Nachricht',
        role: 'message',
        required: true,
      },
      {
        key: 'f_consent',
        type: 'consent',
        label: 'Datenschutz',
        required: true,
        consentText: DEFAULT_CONSENT_TEXT,
      },
    ],
  });
}

// --- submission validation (server-side; client validation is UX only) ---------

/** Values as sent by the embed: key → string | boolean. */
export const formSubmissionValuesSchema = z.record(
  z.string().regex(/^[a-z0-9_]{1,40}$/),
  z.union([z.string().max(6000), z.boolean()])
);
export type FormSubmissionValues = z.infer<typeof formSubmissionValuesSchema>;

const DEFAULT_MAX_LENGTH = 500;
const TEXTAREA_MAX_LENGTH = 5000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ValidatedSubmission =
  | {
      ok: true;
      /** key → cleaned string value ('' dropped) or true for accepted checkboxes. */
      values: Record<string, string | true>;
    }
  | { ok: false; errors: string[] };

/**
 * Validates raw submission values against the stored definition: only defined
 * keys, required satisfied, select/radio values from the options whitelist,
 * length caps, consent must be true. Returns cleaned values keyed by field key.
 */
export function validateSubmission(
  definition: FormDefinition,
  raw: FormSubmissionValues
): ValidatedSubmission {
  const errors: string[] = [];
  const values: Record<string, string | true> = {};
  const known = new Map(definition.fields.map((f) => [f.key, f] as const));

  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      errors.push(`unbekanntes Feld: ${key}`);
    }
  }

  for (const field of definition.fields) {
    const value = raw[field.key];

    if (field.type === 'consent' || field.type === 'checkbox') {
      const accepted = value === true;
      if (field.type === 'consent' && field.required !== false && !accepted) {
        errors.push(`Zustimmung fehlt: ${field.key}`);
      } else if (field.type === 'checkbox' && field.required && !accepted) {
        errors.push(`Pflichtfeld fehlt: ${field.key}`);
      }
      if (accepted) values[field.key] = true;
      continue;
    }

    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length === 0) {
      if (field.required) errors.push(`Pflichtfeld fehlt: ${field.key}`);
      continue;
    }
    const cap =
      field.maxLength ?? (field.type === 'textarea' ? TEXTAREA_MAX_LENGTH : DEFAULT_MAX_LENGTH);
    if (text.length > cap) {
      errors.push(`Feld zu lang: ${field.key}`);
      continue;
    }
    if (field.type === 'email' && !EMAIL_PATTERN.test(text)) {
      errors.push(`Ungültige E-Mail: ${field.key}`);
      continue;
    }
    if ((field.type === 'select' || field.type === 'radio') && field.options) {
      if (!field.options.includes(text)) {
        errors.push(`Ungültige Auswahl: ${field.key}`);
        continue;
      }
    }
    values[field.key] = text;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}

/** First non-empty string value of a field with the given role (else null). */
export function roleValue(
  definition: FormDefinition,
  values: Record<string, string | true>,
  role: FormFieldRole
): string | null {
  for (const field of definition.fields) {
    if (field.role !== role) continue;
    const value = values[field.key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Serializes a validated submission as "Label: Wert" lines — the exact shape
 * looksLikeForm() and the legacy extraction prompts expect, and what agents
 * read in the inbox.
 */
export function serializeSubmission(
  definition: FormDefinition,
  values: Record<string, string | true>
): string {
  const lines: string[] = [];
  for (const field of definition.fields) {
    const value = values[field.key];
    if (value === undefined) continue;
    if (value === true) {
      lines.push(`${field.label}: Ja`);
    } else {
      // multi-line answers keep their label on the first line only
      lines.push(`${field.label}: ${value}`);
    }
  }
  return lines.join('\n');
}

/** Snapshot stored in messages.metadata.form (self-contained, versioned). */
export function submissionSnapshot(params: {
  formId: string;
  version: number;
  definition: FormDefinition;
  values: Record<string, string | true>;
  now: Date;
}): Record<string, unknown> {
  const { formId, version, definition, values, now } = params;
  const consentField = definition.fields.find(
    (f) => f.type === 'consent' && values[f.key] === true
  );
  return {
    form_id: formId,
    version,
    fields: definition.fields
      .filter((f) => values[f.key] !== undefined)
      .map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        value: values[f.key] === true ? 'Ja' : values[f.key],
      })),
    consent: consentField
      ? {
          key: consentField.key,
          text: consentField.consentText ?? DEFAULT_CONSENT_TEXT,
          accepted_at: now.toISOString(),
        }
      : null,
    contact_authoritative: true,
  };
}

/** The subset of the definition the public bootstrap endpoint exposes. */
export function publicDefinition(definition: FormDefinition): Record<string, unknown> {
  return {
    fields: definition.fields.map((f) => ({
      key: f.key,
      type: f.type,
      label: f.label,
      placeholder: f.placeholder,
      required: f.type === 'consent' ? f.required !== false : f.required,
      options: f.options,
      maxLength: f.maxLength,
      consentText: f.consentText,
    })),
    design: definition.design,
    privacyPolicyUrl: definition.privacyPolicyUrl,
    locale: definition.locale,
  };
}
