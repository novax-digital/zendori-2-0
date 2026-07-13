import { describe, expect, it } from 'vitest';
import {
  decideDraftAction,
  detectHandoff,
  isAutopilotEnabled,
  matchesEscalationKeyword,
} from '../src/pipeline/handoff.js';

const KEYWORDS = ['kündigung', 'beschwerde', 'anwalt', 'datenschutz'];

describe('detectHandoff', () => {
  it('hands off on low confidence when nothing else fires', () => {
    expect(
      detectHandoff({
        confidence: 0.4,
        threshold: 0.7,
        wantsHuman: false,
        body: 'Wann kommt meine Lieferung?',
        keywords: KEYWORDS,
      })
    ).toEqual({ handoff: true, reason: 'low_confidence' });
  });

  it('hands off when the customer explicitly wants a human', () => {
    expect(
      detectHandoff({
        confidence: 0.95,
        threshold: 0.7,
        wantsHuman: true,
        body: 'Bitte verbinden Sie mich mit einem Mitarbeiter.',
        keywords: KEYWORDS,
      })
    ).toEqual({ handoff: true, reason: 'user_request' });
  });

  it('hands off on an escalation keyword (case-insensitive)', () => {
    expect(
      detectHandoff({
        confidence: 0.99,
        threshold: 0.7,
        wantsHuman: false,
        body: 'Hiermit erkläre ich die KÜNDIGUNG meines Vertrags.',
        keywords: KEYWORDS,
      })
    ).toEqual({ handoff: true, reason: 'keyword' });
  });

  it('prioritises keyword over wants_human and low confidence', () => {
    expect(
      detectHandoff({
        confidence: 0.1,
        threshold: 0.7,
        wantsHuman: true,
        body: 'Ich schalte meinen Anwalt ein.',
        keywords: KEYWORDS,
      })
    ).toEqual({ handoff: true, reason: 'keyword' });
  });

  it('prioritises wants_human over low confidence', () => {
    expect(
      detectHandoff({
        confidence: 0.1,
        threshold: 0.7,
        wantsHuman: true,
        body: 'Ich hätte gerne einen echten Menschen.',
        keywords: KEYWORDS,
      })
    ).toEqual({ handoff: true, reason: 'user_request' });
  });

  it('does not hand off when confidence meets the threshold exactly', () => {
    expect(
      detectHandoff({
        confidence: 0.7,
        threshold: 0.7,
        wantsHuman: false,
        body: 'Danke für die schnelle Hilfe!',
        keywords: KEYWORDS,
      })
    ).toEqual({ handoff: false, reason: null });
  });

  it('does not hand off with no triggers and empty keywords', () => {
    expect(
      detectHandoff({
        confidence: 0.9,
        threshold: 0.7,
        wantsHuman: false,
        body: 'Beschwerde',
        keywords: [],
      })
    ).toEqual({ handoff: false, reason: null });
  });
});

describe('matchesEscalationKeyword', () => {
  it('matches a substring regardless of case', () => {
    expect(matchesEscalationKeyword('Das ist eine BESCHWERDE!', KEYWORDS)).toBe(true);
  });

  it('ignores empty/whitespace keywords', () => {
    expect(matchesEscalationKeyword('nichts besonderes', ['', '   '])).toBe(false);
  });

  it('returns false when no keyword occurs', () => {
    expect(matchesEscalationKeyword('Frage zur Rechnung', KEYWORDS)).toBe(false);
  });
});

describe('decideDraftAction', () => {
  it('always hands off when a handoff is required, even with autopilot on', () => {
    expect(decideDraftAction(true, true)).toBe('handoff');
    expect(decideDraftAction(true, false)).toBe('handoff');
  });

  it('auto-sends when autopilot is enabled and no handoff is required', () => {
    expect(decideDraftAction(false, true)).toBe('auto_send');
  });

  it('keeps the draft as a suggestion when autopilot is off and no handoff', () => {
    expect(decideDraftAction(false, false)).toBe('pending');
  });
});

describe('isAutopilotEnabled', () => {
  it('is true only for a strict boolean true on the channel key', () => {
    expect(isAutopilotEnabled({ chat: true, email: false }, 'chat')).toBe(true);
    expect(isAutopilotEnabled({ chat: true, email: false }, 'email')).toBe(false);
  });

  it('treats a missing channel key as off', () => {
    expect(isAutopilotEnabled({ chat: true }, 'whatsapp')).toBe(false);
    expect(isAutopilotEnabled({}, 'chat')).toBe(false);
  });

  it('treats truthy-but-not-true values as off', () => {
    expect(isAutopilotEnabled({ chat: 'true' }, 'chat')).toBe(false);
    expect(isAutopilotEnabled({ chat: 1 }, 'chat')).toBe(false);
  });

  it('treats non-objects (null, arrays, primitives) as off', () => {
    expect(isAutopilotEnabled(null, 'chat')).toBe(false);
    expect(isAutopilotEnabled(undefined, 'chat')).toBe(false);
    expect(isAutopilotEnabled(['chat'], 'chat')).toBe(false);
    expect(isAutopilotEnabled('chat', 'chat')).toBe(false);
  });
});
