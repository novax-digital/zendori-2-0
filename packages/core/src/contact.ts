import { z } from 'zod';

// Kontaktanfragen (0034): shared logic of the public contact form — statuses,
// topics, input validation. Used by the web routes (/api/contact/*), the admin
// area and, as plain constants, by the embed. Operator-level like the
// Demo-Anruf (demo.ts): nothing here touches a tenant org.

export const CONTACT_STATUSES = ['new', 'in_progress', 'done'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];
export const contactStatusSchema = z.enum(CONTACT_STATUSES);

export const CONTACT_TOPICS = ['general', 'demo', 'pricing', 'support', 'partner'] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

/** German labels of the topics — the select in the form and the admin list. */
export const CONTACT_TOPIC_LABELS: Record<ContactTopic, string> = {
  general: 'Allgemeine Anfrage',
  demo: 'Demo und Beratung',
  pricing: 'Preise und Pakete',
  support: 'Hilfe zu meinem Konto',
  partner: 'Partnerschaft',
};

/** Bumped whenever the consent wording in the embed changes (stored per request). */
export const CONTACT_CONSENT_VERSION = '2026-11-19';

/** Render-token scope of the contact embed (HMAC input; distinct from forms and the demo). */
export const CONTACT_RENDER_SCOPE = 'contact-form';

export const CONTACT_MESSAGE_MAX_CHARS = 4000;

/** Raw request body — generous bounds here, the real rules live in validateContactRequest. */
export const contactInputSchema = z.object({
  name: z.string().max(500),
  email: z.string().max(500),
  company: z.string().max(500).optional(),
  phone: z.string().max(500).optional(),
  topic: z.string().max(40).optional(),
  message: z.string().max(20_000),
});
export type ContactInput = z.infer<typeof contactInputSchema>;

export type ContactField = 'name' | 'email' | 'company' | 'phone' | 'topic' | 'message';

export interface ContactRequestData {
  name: string;
  email: string;
  company: string | null;
  phone: string | null;
  topic: ContactTopic;
  message: string;
}

export type ContactResult =
  | { ok: true; data: ContactRequestData }
  | { ok: false; errors: Partial<Record<ContactField, string>> };

const emailSchema = z.email();

function singleLine(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** Keeps line breaks, drops control characters, trims trailing spaces per line. */
function multiLine(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function isTopic(value: string): value is ContactTopic {
  return (CONTACT_TOPICS as readonly string[]).includes(value);
}

/**
 * Validates and normalizes a contact request. Error texts are German and shown
 * inline next to the field by the embed (the website addresses visitors with
 * "du").
 */
export function validateContactRequest(input: ContactInput): ContactResult {
  const errors: Partial<Record<ContactField, string>> = {};

  const name = singleLine(input.name);
  if (name.length < 2 || name.length > 120) {
    errors.name = 'Bitte gib deinen Namen an (2–120 Zeichen).';
  }

  const email = singleLine(input.email).toLowerCase();
  if (email.length === 0) {
    errors.email = 'Bitte gib deine E-Mail-Adresse an.';
  } else if (email.length > 200 || !emailSchema.safeParse(email).success) {
    errors.email = 'Bitte gib eine gültige E-Mail-Adresse an.';
  }

  const company = singleLine(input.company);
  if (company.length > 120) {
    errors.company = 'Bitte kürze den Firmennamen (maximal 120 Zeichen).';
  }

  // free-form on purpose (international numbers, extensions): digits must be there
  const phone = singleLine(input.phone);
  if (phone.length > 0 && (phone.length > 40 || !/^[+\d][\d\s()/.-]{4,}$/.test(phone))) {
    errors.phone = 'Bitte gib eine gültige Telefonnummer an oder lass das Feld leer.';
  }

  const rawTopic = singleLine(input.topic);
  const topic: ContactTopic = isTopic(rawTopic) ? rawTopic : 'general';

  const message = multiLine(input.message);
  if (message.length < 10) {
    errors.message = 'Bitte beschreibe dein Anliegen in ein, zwei Sätzen.';
  } else if (message.length > CONTACT_MESSAGE_MAX_CHARS) {
    errors.message = `Bitte fass dich kürzer (maximal ${CONTACT_MESSAGE_MAX_CHARS} Zeichen).`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: {
      name,
      email,
      company: company || null,
      phone: phone || null,
      topic,
      message,
    },
  };
}
