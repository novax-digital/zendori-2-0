import { describe, expect, it } from 'vitest';
import {
  CONTACT_MESSAGE_MAX_CHARS,
  CONTACT_TOPICS,
  CONTACT_TOPIC_LABELS,
  contactInputSchema,
  validateContactRequest,
} from '../src/contact.js';

// Kontaktanfragen (0034): validation of the public contact form.

const VALID = {
  name: '  Anna   Müller ',
  email: ' Anna@Example.COM ',
  company: 'Müller Haustechnik',
  phone: '+49 (511) 123-456',
  topic: 'pricing',
  message: 'Hallo,\r\n\r\nwas kostet Zendori für fünf Mitarbeiter?   \n',
};

describe('validateContactRequest', () => {
  it('normalizes a valid request', () => {
    const result = validateContactRequest(VALID);
    expect(result).toEqual({
      ok: true,
      data: {
        name: 'Anna Müller',
        email: 'anna@example.com',
        company: 'Müller Haustechnik',
        phone: '+49 (511) 123-456',
        topic: 'pricing',
        message: 'Hallo,\n\nwas kostet Zendori für fünf Mitarbeiter?',
      },
    });
  });

  it('treats company and phone as optional and falls back to the general topic', () => {
    const result = validateContactRequest({
      name: 'Anna',
      email: 'anna@example.com',
      topic: 'something-else',
      message: 'Bitte ruft mich zurück.',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.company).toBeNull();
      expect(result.data.phone).toBeNull();
      expect(result.data.topic).toBe('general');
    }
  });

  it('reports every invalid field with a German message', () => {
    const result = validateContactRequest({
      name: 'A',
      email: 'keine-adresse',
      company: 'x'.repeat(121),
      phone: 'ruf mich an',
      message: 'kurz',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(['company', 'email', 'message', 'name', 'phone']);
      expect(result.errors.email).toContain('gültige E-Mail-Adresse');
    }
  });

  it('rejects a missing e-mail and an overlong message', () => {
    const missing = validateContactRequest({ ...VALID, email: '  ' });
    expect(missing.ok).toBe(false);
    const long = validateContactRequest({ ...VALID, message: 'x'.repeat(CONTACT_MESSAGE_MAX_CHARS + 1) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.errors.message).toContain(String(CONTACT_MESSAGE_MAX_CHARS));
  });

  it('strips control characters but keeps line breaks in the message', () => {
    const result = validateContactRequest({ ...VALID, message: 'Zeile eins\u0000\u0007\nZeile zwei\n\n\n\n\n\nEnde' });
    expect(result.ok && result.data.message).toBe('Zeile eins\nZeile zwei\n\n\nEnde');
  });
});

describe('contact constants', () => {
  it('labels every topic', () => {
    for (const topic of CONTACT_TOPICS) expect(CONTACT_TOPIC_LABELS[topic].length).toBeGreaterThan(3);
  });

  it('bounds the raw request body', () => {
    expect(contactInputSchema.safeParse({ name: 'a', email: 'b', message: 'x'.repeat(20_001) }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: 'a', email: 'b', message: 'ok' }).success).toBe(true);
  });
});
