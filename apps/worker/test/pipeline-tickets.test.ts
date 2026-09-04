import { describe, expect, it } from 'vitest';
import { buildTicketSeed } from '../src/pipeline/tickets.js';

// The ticket seed is what the text pipeline hands to ensureTicket when the bot
// cannot close a request (Phase 11): precedence extraction > conversation
// subject (placeholders count as empty) > classification intent.

const classification = {
  language: 'de' as const,
  intent: 'Rechnungsfrage',
  priority: 'high' as const,
  wants_human: false,
  is_spam: false,
  is_auto_reply: false,
  is_new_topic: false,
  summary: 'Kunde fragt nach seiner Rechnung.',
};

const extraction = {
  contact: { name: null, email: null, phone: null, company: null },
  subject: 'Rechnung 4711 fehlt',
  description: 'Die Rechnung für Juli ist nicht angekommen.',
  category: 'Frage',
  missing_fields: [],
  questions: [],
  confidence: 0.9,
};

describe('buildTicketSeed', () => {
  it('prefers the extraction subject/description/category', () => {
    expect(
      buildTicketSeed({ conv: { subject: 'Re: irgendwas' }, classification, extraction, messageId: 'm1' })
    ).toEqual({
      subject: 'Rechnung 4711 fehlt',
      description: 'Die Rechnung für Juli ist nicht angekommen.',
      category: 'Frage',
      priority: 'high',
      openedMessageId: 'm1',
      newTopic: false,
    });
  });

  it('falls back to the conversation subject, then to the intent; placeholders count as empty', () => {
    expect(
      buildTicketSeed({ conv: { subject: 'Störung Wallbox' }, classification, extraction: null, messageId: 'm2' })
        .subject
    ).toBe('Störung Wallbox');
    expect(
      buildTicketSeed({ conv: { subject: 'Anruf von +49' }, classification, extraction: null, messageId: 'm3' })
        .subject
    ).toBe('Rechnungsfrage');
    expect(buildTicketSeed({ conv: { subject: null }, classification: null, extraction: null, messageId: 'm4' })).toEqual({
      subject: null,
      description: null,
      category: null,
      priority: null,
      openedMessageId: 'm4',
      newTopic: false,
    });
  });

  it('uses the classification summary as description without an extraction', () => {
    expect(
      buildTicketSeed({ conv: { subject: null }, classification, extraction: null, messageId: 'm5' }).description
    ).toBe('Kunde fragt nach seiner Rechnung.');
  });
});

describe('buildTicketSeed newTopic (attach rule v2)', () => {
  it('carries classification.is_new_topic', () => {
    expect(
      buildTicketSeed({ conv: { subject: null }, classification: { ...classification, is_new_topic: true }, extraction: null, messageId: 'm6' })
        .newTopic
    ).toBe(true);
    expect(buildTicketSeed({ conv: { subject: null }, classification, extraction: null, messageId: 'm7' }).newTopic).toBe(false);
  });
});
