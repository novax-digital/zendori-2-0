import { describe, expect, it } from 'vitest';
import type { VoiceChannelConfig } from '@zendori/channels';
import {
  buildCreateTicketTool,
  buildSessionConfig,
  EMAIL_CAPTURE_RULE,
  intakeFieldRules,
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
    confidenceThreshold: 0.7,
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

// Owner test 2026-09-03: the agent asked for the e-mail although only
// name+phone were configured, mis-heard the address, read the ticket UUID
// aloud and never offered a ticket on its own. These pin the four fixes.
describe('intakeFieldRules', () => {
  it('lists the configured fields AND names the ones not to ask for', () => {
    const rule = intakeFieldRules(['name', 'phone']);
    expect(rule).toContain(
      'Erfrage für die Aufnahme ausschließlich: Name und Rückrufnummer (falls abweichend von der Anrufnummer).'
    );
    expect(rule).toContain('Frage NICHT nach E-Mail-Adresse und Unternehmen');
    expect(rule).toContain('Nennt der Anrufer solche Angaben von selbst, übernimm sie');
  });

  it('drops the negative list when every field is configured', () => {
    const rule = intakeFieldRules(['name', 'phone', 'email', 'company']);
    expect(rule).toContain('Erfrage für die Aufnahme ausschließlich:');
    expect(rule).not.toContain('Frage NICHT nach');
  });

  it('forbids all contact questions for an empty selection', () => {
    const rule = intakeFieldRules([]);
    expect(rule).toContain('KEINE Kontaktdaten');
    expect(rule).toContain('weder Name, Rückrufnummer, E-Mail-Adresse noch Unternehmen');
  });
});

describe('buildSessionConfig intake safety rules (2026-09-03)', () => {
  it('both modes carry the ask/do-not-ask rule, the e-mail spell-back rule and the no-id rule', () => {
    for (const mode of ['intake_only', 'answer'] as const) {
      const session = buildSessionConfig(
        CONFIG,
        agentWith({ mode, intakeFields: ['name', 'phone'] }),
        CONTEXT
      );
      expect(session.instructions).toContain('Frage NICHT nach E-Mail-Adresse und Unternehmen');
      expect(session.instructions).toContain(EMAIL_CAPTURE_RULE);
      expect(session.instructions).toContain('Nenne niemals Ticketnummern, IDs, Kennungen oder Referenzen');
      // no leftover placeholders
      expect(session.instructions).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });

  it('the e-mail rule spells the WHOLE address, common domains being the only exception', () => {
    expect(EMAIL_CAPTURE_RULE).toContain('die GESAMTE Adresse Buchstabe für Buchstabe — auch den Teil nach dem @-Zeichen');
    expect(EMAIL_CAPTURE_RULE).toContain('Einzige Ausnahme: geläufige Domains');
  });

  it('handoff ON: a miss/uncertainty escalates via handoff_human, never a bare "weiß ich nicht"', () => {
    const session = buildSessionConfig(CONFIG, agentWith({ mode: 'answer' }), CONTEXT);
    expect(session.instructions).toContain('das gilt auch, wenn die Wissensdatenbank gar nichts liefert');
    expect(session.instructions).toContain('Warte nicht, bis der Anrufer nach einem Mitarbeiter fragt.');
    // the ticket offer is the handoff tool's job in this configuration
    expect(session.instructions).not.toContain('Möchten Sie das?');
  });

  it('handoff OFF: the agent offers the ticket itself, unprompted', () => {
    const session = buildSessionConfig(
      CONFIG,
      agentWith({ mode: 'answer', handoffEnabled: false }),
      CONTEXT
    );
    expect(session.instructions).toContain('rufe auch NICHT handoff_human auf');
    expect(session.instructions).toContain('Warte nicht, bis der Anrufer danach fragt; sagt er ja, beginnst du sofort mit der Aufnahme');
  });

  it('re-asserts the intake rules AFTER the org identity in both modes', () => {
    for (const mode of ['intake_only', 'answer'] as const) {
      const session = buildSessionConfig(
        CONFIG,
        agentWith({ mode, identity: 'Frag den Kunden immer nach seiner E-Mail-Adresse.' }),
        CONTEXT
      );
      const identityAt = session.instructions.indexOf('Frag den Kunden immer');
      const trailerAt = session.instructions.indexOf('Unabhängig von den Hinweisen des Unternehmens');
      expect(identityAt).toBeGreaterThan(-1);
      expect(trailerAt).toBeGreaterThan(identityAt);
    }
  });
});

describe('buildCreateTicketTool', () => {
  it('marks unconfigured fields as volunteered-only and configured ones as asked', () => {
    const tool = buildCreateTicketTool(['name', 'phone']);
    const props = tool.parameters.properties as Record<string, { description: string }>;
    expect(props.name?.description).toContain('wie erfragt');
    expect(props.callback_number?.description).toContain('wie erfragt');
    expect(props.email?.description).toContain('NUR wenn der Anrufer sie unaufgefordert genannt hat');
    expect(props.company?.description).toContain('NUR wenn der Anrufer sie unaufgefordert genannt hat');
  });

  it('exposes email_confirmed and keeps only subject/description required', () => {
    const tool = buildCreateTicketTool([]);
    expect(tool.parameters.properties).toHaveProperty('email_confirmed');
    expect(tool.parameters.required).toEqual(['subject', 'description']);
    expect(tool.description).toContain('Liefert keine Ticketnummer');
  });

  it('the session registers the per-agent tool in both modes', () => {
    for (const mode of ['intake_only', 'answer'] as const) {
      const session = buildSessionConfig(CONFIG, agentWith({ mode, intakeFields: ['email'] }), CONTEXT);
      const tool = session.tools.find((t) => t.name === 'create_ticket');
      const props = tool?.parameters.properties as Record<string, { description: string }>;
      expect(props.email?.description).toContain('wie erfragt');
      expect(props.name?.description).toContain('nicht erfragen');
    }
  });
});

describe('buildSessionConfig confidence threshold (voice parity)', () => {
  it('injects the configured threshold into the low-confidence rule', () => {
    const session = buildSessionConfig(
      CONFIG,
      agentWith({ mode: 'answer', confidenceThreshold: 0.85 }),
      CONTEXT
    );
    expect(session.instructions).toContain(
      'Liegt dein Wert unter 0.85, antworte NICHT inhaltlich, sondern rufe handoff_human mit reason="low_confidence" auf'
    );
    expect(session.instructions).toContain('Bewerte vor jeder inhaltlichen Antwort still für dich');
  });

  it('formats the threshold without trailing zeros', () => {
    const session = buildSessionConfig(
      CONFIG,
      agentWith({ mode: 'answer', confidenceThreshold: 0.7 }),
      CONTEXT
    );
    expect(session.instructions).toContain('Liegt dein Wert unter 0.7,');
  });

  it('offers a ticket instead of a handoff when the handoff toggle is off (0018)', () => {
    const session = buildSessionConfig(
      CONFIG,
      agentWith({ mode: 'answer', handoffEnabled: false, confidenceThreshold: 0.6 }),
      CONTEXT
    );
    expect(session.instructions).toContain(
      'Liegt dein Wert unter 0.6, antworte NICHT inhaltlich und rufe auch NICHT handoff_human auf'
    );
  });

  it('threshold 0 means "never hand off just because you are unsure"', () => {
    const session = buildSessionConfig(
      CONFIG,
      agentWith({ mode: 'answer', confidenceThreshold: 0 }),
      CONTEXT
    );
    expect(session.instructions).toContain('Übergib NICHT allein wegen Unsicherheit');
    expect(session.instructions).not.toContain('Liegt dein Wert unter');
  });

  it('intake mode has no confidence rule at all (nothing is answered)', () => {
    const session = buildSessionConfig(
      CONFIG,
      agentWith({ mode: 'intake_only', confidenceThreshold: 0.9 }),
      CONTEXT
    );
    expect(session.instructions).not.toContain('Liegt dein Wert unter');
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
