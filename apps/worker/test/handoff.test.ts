import { describe, expect, it } from 'vitest';
import { decideDraftAction, detectHandoff, matchesEscalationKeyword } from '../src/pipeline/handoff.js';

const KEYWORDS = ['kündigung', 'beschwerde', 'anwalt', 'datenschutz'];

/** Default input: every §6 trigger off, toggle ON (today's behavior). */
function input(overrides: Partial<Parameters<typeof detectHandoff>[0]>) {
  return {
    confidence: 0.9,
    threshold: 0.7,
    wantsHuman: false,
    body: 'Wann kommt meine Lieferung?',
    keywords: KEYWORDS,
    handoffEnabled: true,
    ...overrides,
  };
}

describe('detectHandoff', () => {
  it('hands off on low confidence when nothing else fires', () => {
    expect(detectHandoff(input({ confidence: 0.4 }))).toEqual({
      handoff: true,
      reason: 'low_confidence',
      suppressed: false,
    });
  });

  it('hands off when the customer explicitly wants a human', () => {
    expect(
      detectHandoff(
        input({ wantsHuman: true, body: 'Bitte verbinden Sie mich mit einem Mitarbeiter.' })
      )
    ).toEqual({ handoff: true, reason: 'user_request', suppressed: false });
  });

  it('hands off on an escalation keyword (case-insensitive)', () => {
    expect(
      detectHandoff(input({ body: 'Hiermit erkläre ich die KÜNDIGUNG meines Vertrags.' }))
    ).toEqual({ handoff: true, reason: 'keyword', suppressed: false });
  });

  it('prioritises keyword over wants_human and low confidence', () => {
    expect(
      detectHandoff(
        input({ confidence: 0.1, wantsHuman: true, body: 'Ich schalte meinen Anwalt ein.' })
      )
    ).toEqual({ handoff: true, reason: 'keyword', suppressed: false });
  });

  it('prioritises wants_human over low confidence', () => {
    expect(
      detectHandoff(
        input({ confidence: 0.1, wantsHuman: true, body: 'Ich hätte gerne einen echten Menschen.' })
      )
    ).toEqual({ handoff: true, reason: 'user_request', suppressed: false });
  });

  it('does not hand off when confidence meets the threshold exactly', () => {
    expect(detectHandoff(input({ confidence: 0.7, body: 'Danke für die schnelle Hilfe!' }))).toEqual(
      { handoff: false, reason: null, suppressed: false }
    );
  });

  it('does not hand off with no triggers and empty keywords', () => {
    expect(detectHandoff(input({ body: 'Beschwerde', keywords: [] }))).toEqual({
      handoff: false,
      reason: null,
      suppressed: false,
    });
  });

  // --- 0018 toggle semantics (owner decision 2026-07-21) -------------------------

  it('toggle OFF suppresses ONLY low_confidence (marked suppressed, never silent)', () => {
    expect(detectHandoff(input({ confidence: 0.4, handoffEnabled: false }))).toEqual({
      handoff: false,
      reason: null,
      suppressed: true,
    });
  });

  it('toggle OFF still hands off on an explicit human wish', () => {
    expect(
      detectHandoff(input({ confidence: 0.4, wantsHuman: true, handoffEnabled: false }))
    ).toEqual({ handoff: true, reason: 'user_request', suppressed: false });
  });

  it('toggle OFF still hands off on an escalation keyword', () => {
    expect(
      detectHandoff(
        input({ confidence: 0.99, body: 'Ich habe eine Beschwerde.', handoffEnabled: false })
      )
    ).toEqual({ handoff: true, reason: 'keyword', suppressed: false });
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

  it('NEVER auto-sends a suppressed low-confidence draft (0018 trap)', () => {
    // Without this rule the toggle would ship the below-threshold answer the
    // org explicitly did not trust — the draft must stay a suggestion.
    expect(decideDraftAction(false, true, true)).toBe('pending');
    expect(decideDraftAction(false, false, true)).toBe('pending');
  });
});
