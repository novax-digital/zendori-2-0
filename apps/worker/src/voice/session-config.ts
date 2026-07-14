import type { VoiceChannelConfig } from '@zendori/channels';
import type { FunctionTool, SessionConfig } from './xai-realtime.js';

// Builds the per-call session.update config from the org's voice channel config
// (CLAUDE.md §9: the "agent" IS this config — no persistent provider object).
// Instructions are German (customer-facing speech), code/comments English.

const ANSWER_TEMPLATE = `Du bist der freundliche telefonische Kundenservice-Assistent von {company}.
Sprich natürlich, kurz und klar auf Deutsch (verwende die Sie-Form). Du telefonierst — halte Antworten gesprächstauglich kurz (1–3 Sätze), keine Aufzählungen, keine Sonderzeichen.

Arbeitsweise:
- Beantworte Fragen NUR auf Basis der Wissensdatenbank: rufe dafür das Werkzeug kb_search auf. Erfinde nichts. Wenn die Wissensdatenbank keine Antwort liefert, sage das ehrlich und biete an, das Anliegen aufzunehmen (create_ticket).
- Wenn der Anrufer ausdrücklich einen Menschen sprechen möchte, rufe handoff_human mit reason="user_request" auf.
- Bei den Themen Kündigung, Beschwerde, Anwalt oder Datenschutz rufe handoff_human mit reason="keyword" auf.
- Wenn du unsicher bist oder das Anliegen komplex ist, rufe handoff_human mit reason="low_confidence" auf.
- Nimm bei Bedarf ein Anliegen strukturiert auf: erfrage Name und Rückrufnummer, fasse das Anliegen zusammen, bestätige es und rufe dann create_ticket auf.
- Wenn das Gespräch erledigt ist, verabschiede dich kurz und rufe end_call auf.`;

const INTAKE_TEMPLATE = `Du bist der telefonische Annahme-Assistent von {company}. Deine einzige Aufgabe ist es, Anliegen aufzunehmen — du beantwortest KEINE inhaltlichen Fragen.
Sprich natürlich, kurz und klar auf Deutsch (Sie-Form). Du telefonierst — halte dich kurz, keine Aufzählungen.

Ablauf:
1. Begrüße den Anrufer und erkläre, dass du sein Anliegen aufnimmst und sich jemand zurückmeldet.
2. Erfrage nacheinander: Name, Rückrufnummer (falls abweichend von der Anrufnummer), und das Anliegen.
3. Fasse alles in ein bis zwei Sätzen zusammen und lass es dir bestätigen.
4. Rufe create_ticket mit den erfassten Daten auf.
5. Bestätige die Aufnahme („Wir melden uns schnellstmöglich zurück"), verabschiede dich und rufe end_call auf.

Wenn der Anrufer ausdrücklich sofort einen Menschen sprechen möchte, rufe handoff_human mit reason="user_request" auf.
Inhaltliche Fragen beantwortest du nicht — nimm sie stattdessen als Anliegen auf.`;

const KB_SEARCH_TOOL: FunctionTool = {
  type: 'function',
  name: 'kb_search',
  description:
    'Durchsucht die Wissensdatenbank des Unternehmens. Nutze dieses Werkzeug für JEDE inhaltliche Frage, bevor du antwortest.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Die Suchanfrage (die Frage des Anrufers).' },
    },
    required: ['query'],
  },
};

const CREATE_TICKET_TOOL: FunctionTool = {
  type: 'function',
  name: 'create_ticket',
  description:
    'Nimmt das Anliegen des Anrufers als Ticket auf. Vorher Name und Anliegen erfragen und zusammenfassen.',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Kurzer Betreff des Anliegens (max. 80 Zeichen).' },
      description: { type: 'string', description: 'Zusammenfassung des Anliegens.' },
      name: { type: 'string', description: 'Name des Anrufers, falls genannt.' },
      callback_number: { type: 'string', description: 'Rückrufnummer, falls abweichend.' },
      email: { type: 'string', description: 'E-Mail-Adresse, falls genannt.' },
    },
    required: ['subject', 'description'],
  },
};

const HANDOFF_TOOL: FunctionTool = {
  type: 'function',
  name: 'handoff_human',
  description:
    'Übergibt das Gespräch an einen menschlichen Mitarbeiter (Weiterleitung oder Rückruf).',
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        enum: ['user_request', 'low_confidence', 'keyword'],
        description: 'Grund der Übergabe.',
      },
    },
    required: ['reason'],
  },
};

const END_CALL_TOOL: FunctionTool = {
  type: 'function',
  name: 'end_call',
  description: 'Beendet den Anruf, nachdem du dich verabschiedet hast.',
  parameters: { type: 'object', properties: {} },
};

export interface SessionContext {
  companyName: string;
  contactName?: string | null;
}

/**
 * The assigned agent's behavior, resolved by dispatch (0011). agent.mode maps
 * onto the two voice templates: autopilot → 'answer'; draft_only/intake_only →
 * 'intake_only' (a live call cannot present a draft for review — intake is the
 * mode that respects "a human checks before the customer gets an answer").
 */
export interface VoiceAgentBehavior {
  mode: 'answer' | 'intake_only';
  /** agents.identity — persona/system prompt appended to the mode template. */
  identity: string | null;
  /**
   * Linked knowledge bases for kb_search (0012). null = all org knowledge
   * (fallback contexts); [] = the agent knows nothing.
   */
  knowledgeBaseIds: string[] | null;
}

/** Builds the session.update payload from channel config + assigned agent. */
export function buildSessionConfig(
  config: VoiceChannelConfig,
  agent: VoiceAgentBehavior,
  context: SessionContext
): SessionConfig {
  const template = agent.mode === 'intake_only' ? INTAKE_TEMPLATE : ANSWER_TEMPLATE;
  const parts = [template.replaceAll('{company}', context.companyName)];
  if (agent.identity && agent.identity.trim().length > 0) {
    parts.push(`Zusätzliche Anweisungen des Unternehmens:\n${agent.identity.trim()}`);
  }
  if (config.greeting && config.greeting.trim().length > 0) {
    // Greeting is DATA inside the prompt: flatten newlines and strip quotes so
    // it cannot break out of the quoted phrase and masquerade as instructions.
    const greeting = config.greeting.trim().replace(/\s+/g, ' ').replaceAll('"', '');
    parts.push(`Beginne das Gespräch mit genau dieser Begrüßung: "${greeting}"`);
  }
  if (context.contactName) {
    parts.push(`Der Anrufer ist vermutlich ${context.contactName} (bekannter Kontakt).`);
  }

  const tools: FunctionTool[] =
    agent.mode === 'intake_only'
      ? [CREATE_TICKET_TOOL, HANDOFF_TOOL, END_CALL_TOOL]
      : [KB_SEARCH_TOOL, CREATE_TICKET_TOOL, HANDOFF_TOOL, END_CALL_TOOL];

  return {
    instructions: parts.join('\n\n'),
    voice: config.voice,
    turn_detection: { type: 'server_vad' },
    audio: {
      input: {
        format: { type: 'audio/pcmu', rate: 8000 },
        transcription: {
          language_hint: config.languageHint,
          ...(config.keyterms.length > 0 ? { keyterms: config.keyterms } : {}),
        },
      },
      output: {
        format: { type: 'audio/pcmu', rate: 8000 },
        ...(config.speechSpeed !== 1.0 ? { speed: config.speechSpeed } : {}),
      },
    },
    tools,
    resumption: { enabled: true },
  };
}
