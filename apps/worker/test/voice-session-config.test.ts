import { describe, expect, it } from 'vitest';
import type { VoiceChannelConfig } from '@zendori/channels';
import {
  buildSessionConfig,
  intakeFieldsPhrase,
  type VoiceAgentBehavior,
} from '../src/voice/session-config.js';
import { callbackIntakeStep } from '../src/voice/tools.js';

// The configurable intake fields (0027): agents.intake_fields decides which
// contact data the voice prompt actively asks for; the create_ticket tool keeps
// all optional parameters so volunteered data is still captured.

const CONFIG: VoiceChannelConfig = {
  type: 'voice',
  provider: 'xai',
  phoneNumber: '+493022334455',
  dispatchSigningSecretEncrypted: 'v1:x:y',
  voice: 'eve',
  languageHint: 'de',
  keyterms: [],
  speechSpeed: 1.0,
  maxCallSeconds: 900,
  connectionState: 'active',
};

function agentWith(over: Partial<VoiceAgentBehavior> = {}): VoiceAgentBehavior {
  return {
    mode: 'intake_only',
    identity: null,
    knowledgeBaseIds: null,
    handoffEnabled: true,
    intakeFields: ['name', 'phone'],
    ...over,
  };
}

const CONTEXT = { companyName: 'Testfirma' };

describe('intakeFieldsPhrase', () => {
  it('joins the configured fields with commas and "und"', () => {
    expect(intakeFieldsPhrase(['name', 'email', 'company'])).toBe(
      'Name, E-Mail-Adresse und Name des Unternehmens beziehungsweise der Firma'
    );
  });

  it('returns a single field without connectors', () => {
    expect(intakeFieldsPhrase(['name'])).toBe('Name');
  });

  it('returns an empty string for an empty selection', () => {
    expect(intakeFieldsPhrase([])).toBe('');
  });
});

describe('buildSessionConfig intake fields (0027)', () => {
  it('intake mode asks for the default fields (name + callback number)', () => {
    const session = buildSessionConfig(CONFIG, agentWith(), CONTEXT);
    expect(session.instructions).toContain(
      'Erfrage nacheinander: Name und Rückrufnummer (falls abweichend von der Anrufnummer) — und dann das Anliegen.'
    );
  });

  it('intake mode asks for the company when configured', () => {
    const session = buildSessionConfig(
      CONFIG,
      agentWith({ intakeFields: ['name', 'phone', 'email', 'company'] }),
      CONTEXT
    );
    expect(session.instructions).toContain('Name des Unternehmens beziehungsweise der Firma');
    expect(session.instructions).toContain('E-Mail-Adresse');
  });

  it('an empty selection asks only for the request itself', () => {
    const session = buildSessionConfig(CONFIG, agentWith({ intakeFields: [] }), CONTEXT);
    expect(session.instructions).toContain('Erfrage das Anliegen.');
    expect(session.instructions).not.toContain('Erfrage nacheinander');
  });

  it('answer mode injects the fields into the create_ticket bullet', () => {
    const session = buildSessionConfig(
      CONFIG,
      agentWith({ mode: 'answer', intakeFields: ['name', 'company'] }),
      CONTEXT
    );
    expect(session.instructions).toContain(
      'erfrage Name und Name des Unternehmens beziehungsweise der Firma, fasse das Anliegen zusammen'
    );
  });

  it('answer mode with an empty selection drops the "erfrage" part', () => {
    const session = buildSessionConfig(
      CONFIG,
      agentWith({ mode: 'answer', intakeFields: [] }),
      CONTEXT
    );
    expect(session.instructions).toContain(
      'Nimm bei Bedarf ein Anliegen strukturiert auf: fasse das Anliegen zusammen'
    );
  });

  it('create_ticket exposes a company parameter in both modes', () => {
    for (const mode of ['intake_only', 'answer'] as const) {
      const session = buildSessionConfig(CONFIG, agentWith({ mode }), CONTEXT);
      const tool = session.tools.find((t) => t.name === 'create_ticket');
      expect(tool?.parameters.properties).toHaveProperty('company');
    }
  });
});

describe('callbackIntakeStep', () => {
  it('mirrors the configured fields in the callback instruction', () => {
    expect(callbackIntakeStep(['name', 'company'])).toBe(
      'erfrage Name und Name des Unternehmens beziehungsweise der Firma, fasse das Anliegen zusammen'
    );
  });

  it('falls back to summarising only when nothing is configured', () => {
    expect(callbackIntakeStep([])).toBe('fasse das Anliegen zusammen');
  });
});
