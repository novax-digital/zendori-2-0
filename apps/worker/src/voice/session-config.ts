import type { VoiceChannelConfig } from '@zendori/channels';
import type { IntakeField } from '@zendori/core';
import type { FunctionTool, SessionConfig } from './xai-realtime.js';

// Builds the per-call session.update config from the org's voice channel config
// (CLAUDE.md §9: the "agent" IS this config — no persistent provider object).
// Instructions are German (customer-facing speech), code/comments English.

// Lookup announcements (owner feedback 2026-07-23): callers heard the same
// "einen kleinen Augenblick…" before EVERY lookup, even sub-second ones. The
// prompt now forbids the ritual; genuinely slow lookups are bridged by the
// timer-gated spoken filler in call-session.ts (TOOL_FILLER_DELAY_MS).
const ANSWER_TEMPLATE = `Du bist der freundliche telefonische Kundenservice-Assistent von {company}.
Sprich natürlich, kurz und klar (verwende die Höflichkeitsform). Du telefonierst — halte Antworten gesprächstauglich kurz (1–3 Sätze), keine Aufzählungen, keine Sonderzeichen.

Arbeitsweise:
- Beantworte Fragen NUR auf Basis der Wissensdatenbank: rufe dafür das Werkzeug kb_search auf. Erfinde nichts. Wenn die Wissensdatenbank keine Antwort liefert, sage das ehrlich („Das kann ich Ihnen gerade nicht sagen") und biete an, das Anliegen aufzunehmen (create_ticket).
- Wenn die Antwort schon aus dem bisherigen Gespräch bekannt ist (z. B. bereits nachgeschlagen oder eben besprochen), antworte direkt — ohne erneutes Nachschlagen und ohne Ankündigung.
- Kündige das Nachschlagen NICHT rituell an: rufe kb_search in der Regel einfach direkt auf, eine kurze natürliche Pause ist völlig in Ordnung. Wenn du vor einem Nachschlagen doch etwas sagst, halte es sehr kurz und variiere die Formulierung — nie zweimal dieselbe Floskel im selben Gespräch, und versprich niemals routinemäßig „einen kleinen Augenblick".
- Formuliere die Suchanfrage präzise und nutze Produkt- und Eigennamen, wenn der Anrufer welche genannt hat. Liefert die Suche nichts Passendes, versuche genau EINE zweite Suche mit anderen Begriffen (Synonym, Produktname, Oberbegriff), bevor du sagst, dass du es nicht weißt.
- Wenn der Anrufer ausdrücklich einen Menschen sprechen möchte, rufe handoff_human mit reason="user_request" auf.
- Bei den Themen {keywords} rufe handoff_human mit reason="keyword" auf.
{lowConfidenceRule}
- Nimm bei Bedarf ein Anliegen strukturiert auf: {intakeStep}fasse das Anliegen zusammen, bestätige es und rufe dann create_ticket auf.
- Wenn das Gespräch erledigt ist: bestätige zuerst vollständig und freundlich, was du getan hast, und rufe DANN end_call auf. Die Verabschiedung („Auf Wiederhören") spricht das System danach automatisch — verabschiede dich nicht selbst, sonst hört der Anrufer sie doppelt. Beende niemals mitten im Satz.`;

// --- confidence threshold (agents.confidence_threshold, voice parity) --------
// The text pipeline compares a model-reported confidence against the agent's
// threshold in code (process-message.ts). A realtime call has no draft to gate:
// the model speaks directly, so the only place the threshold can act is the
// prompt — the model self-assesses with the SAME anchors the draft prompt uses
// (packages/ai/src/prompts.ts) and compares against the injected number itself.
// Soft by nature (a model rule, not a code gate) — the hard guarantees stay
// where they are: the handoff toggle is enforced in handoffTool, kb_search only
// returns what the knowledge base actually covers.

/** 0.7 → "0.7", 0.85 → "0.85" (step is 0.05 — two decimals are enough). */
function formatThreshold(value: number): string {
  return String(Math.round(value * 100) / 100);
}

const CONFIDENCE_SCALE =
  'Bewerte vor jeder inhaltlichen Antwort still für dich, wie sicher du dir bist (Skala 0 bis 1): 0.9–1.0 = jede Sachaussage eindeutig durch die Wissensdatenbank gedeckt, oder reine Gesprächsführung ohne Faktenbedarf · 0.7–0.89 = die Kernfrage sicher gedeckt, höchstens Nebenaspekte offen · 0.4–0.69 = nur teilweise gedeckt oder die Quellen sind mehrdeutig · 0.0–0.39 = die eigentliche Frage ist gar nicht gedeckt.';

/**
 * The low_confidence bullet depends on the agent's handoff toggle (0018) and
 * its confidence threshold: enabled → escalate uncertainty below the threshold
 * to a human; disabled → admit the limit and offer a ticket instead (the tool
 * additionally refuses reason='low_confidence' server-side — the prompt is UX,
 * the tool is the guarantee). Threshold 0 = "never hand off just because you
 * are unsure": a "below 0" rule would be vacuous, so that case gets its own
 * wording instead of an unreachable comparison.
 */
function lowConfidenceRule(handoffEnabled: boolean, threshold: number): string {
  if (threshold <= 0) {
    return handoffEnabled
      ? '- Übergib NICHT allein wegen Unsicherheit an einen Menschen. Antworte so gut, wie die Wissensdatenbank es zulässt, und sage nur dann ehrlich „Das kann ich Ihnen gerade nicht sagen", wenn die Quellen wirklich nichts hergeben.'
      : '- Übergib NICHT wegen Unsicherheit — rufe dafür niemals handoff_human auf. Antworte so gut, wie die Wissensdatenbank es zulässt, und biete sonst an, das Anliegen aufzunehmen (create_ticket).';
  }
  const t = formatThreshold(threshold);
  return handoffEnabled
    ? `- ${CONFIDENCE_SCALE} Liegt dein Wert unter ${t}, antworte NICHT inhaltlich, sondern rufe handoff_human mit reason="low_confidence" auf. Bei ${t} oder höher antwortest du selbst.`
    : `- ${CONFIDENCE_SCALE} Liegt dein Wert unter ${t}, antworte NICHT inhaltlich und rufe auch NICHT handoff_human auf — sage ehrlich, dass du das gerade nicht sicher sagen kannst, und biete an, das Anliegen aufzunehmen (create_ticket). Bei ${t} oder höher antwortest du selbst.`;
}

/** Default escalation topics when the org has not configured its own list. */
const DEFAULT_ESCALATION_TOPICS = ['Kündigung', 'Beschwerde', 'Anwalt', 'Datenschutz'];

// --- configurable intake fields (0027) ---------------------------------------
// agents.intake_fields decides which contact data the agent actively asks the
// caller for before create_ticket. The tool keeps ALL optional parameters
// regardless (volunteered data is still captured) — the prompt controls only
// what is actively asked.

const INTAKE_FIELD_PHRASES: Record<IntakeField, string> = {
  name: 'Name',
  phone: 'Rückrufnummer (falls abweichend von der Anrufnummer)',
  email: 'E-Mail-Adresse',
  company: 'Name des Unternehmens beziehungsweise der Firma',
};

/**
 * Spoken-German enumeration of the configured intake fields ("Name,
 * E-Mail-Adresse und …"). Empty selection → empty string (callers of this
 * helper phrase their sentence without an "erfrage" part then).
 */
export function intakeFieldsPhrase(fields: IntakeField[]): string {
  const phrases = fields.map((f) => INTAKE_FIELD_PHRASES[f]);
  if (phrases.length === 0) return '';
  if (phrases.length === 1) return phrases[0]!;
  return `${phrases.slice(0, -1).join(', ')} und ${phrases[phrases.length - 1]!}`;
}

const INTAKE_TEMPLATE = `Du bist der telefonische Annahme-Assistent von {company}. Deine einzige Aufgabe ist es, Anliegen aufzunehmen — du beantwortest KEINE inhaltlichen Fragen.
Sprich natürlich, kurz und klar (Höflichkeitsform). Du telefonierst — halte dich kurz, keine Aufzählungen.

Ablauf:
1. Begrüße den Anrufer und erkläre, dass du sein Anliegen aufnimmst und sich jemand zurückmeldet.
2. {intakeQuestions}
3. Fasse alles in ein bis zwei Sätzen zusammen und lass es dir bestätigen.
4. Rufe create_ticket mit den erfassten Daten auf.
5. Bestätige die Aufnahme mit einem vollständigen, freundlichen Satz („Ihr Anliegen ist aufgenommen — wir melden uns schnellstmöglich zurück.") und rufe DANN end_call auf. Die Verabschiedung spricht das System danach automatisch — verabschiede dich nicht selbst. Beende niemals mitten im Satz.

Wenn der Anrufer ausdrücklich sofort einen Menschen sprechen möchte, rufe handoff_human mit reason="user_request" auf.
Inhaltliche Fragen beantwortest du nicht — nimm sie stattdessen als Anliegen auf.`;

// Shared style rules for both modes — live-gate feedback (2026-07-15/21): the
// model read English product terms with German pronunciation and addressed the
// caller as "Herr <Vorname>". Pronunciation needs to be drilled explicitly and
// with examples, a single generic line was not enough.
const STYLE_RULES = `Aussprache und Anrede:
- WICHTIG: Englische Wörter, Anglizismen, Produkt- und Markennamen sprichst du IMMER mit englischer Aussprache — so, wie ein englischer Muttersprachler sie sagt. Wende NIEMALS deutsche Leseregeln auf englische Wörter an.
- Beispiele für englische Aussprache: "Support", "Service", "Ticket", "Update", "Online-Shop", "E-Mail", "All-in-One", "Team", "Website", "Login", "Account", "Newsletter", "Download".
- Das gilt auch mitten im deutschen Satz: wechsle für das englische Wort kurz in die englische Aussprache und danach zurück.
- Sprich Anrufer niemals mit "Herr" oder "Frau" plus Vornamen an. Nur ein Nachname bekommt eine förmliche Anrede; ist nur der Vorname bekannt, verzichte auf die förmliche Anrede.
- Sprich NIEMALS über interne Technik: keine "Wissensdatenbank", keine "Datenbank", kein "System", keine Werkzeug- oder Funktionsnamen. Du "schaust kurz nach" oder "prüfst das" — mehr sagst du dazu nicht.`;

/**
 * Conversation language: languageHint doubles as the call language. The
 * instructions themselves stay German (the model follows them regardless);
 * this block pins which language is SPOKEN. Unknown hints fall back to the
 * hint string itself (custom locales still work, e.g. "de-AT").
 */
const LANGUAGE_NAMES: Record<string, string> = {
  de: 'Deutsch',
  en: 'Englisch',
  fr: 'Französisch',
  es: 'Spanisch',
  it: 'Italienisch',
  nl: 'Niederländisch',
  pl: 'Polnisch',
  tr: 'Türkisch',
};

function languageRules(languageHint: string): string {
  const name = LANGUAGE_NAMES[languageHint] ?? languageHint;
  return `Gesprächssprache:
- Führe das Gespräch grundsätzlich auf ${name}.
- Wenn der Anrufer erkennbar eine andere Sprache spricht, wechsle in dessen Sprache und bleibe dabei.`;
}

const KB_SEARCH_TOOL: FunctionTool = {
  type: 'function',
  name: 'kb_search',
  description:
    'Durchsucht die Wissensdatenbank des Unternehmens. Nutze dieses Werkzeug vor dem Antworten für jede inhaltliche Frage, deren Antwort du nicht bereits aus dem bisherigen Gespräch kennst.',
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
    'Nimmt das Anliegen des Anrufers als Ticket auf. Vorher die benötigten Angaben und das Anliegen erfragen und zusammenfassen.',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Kurzer Betreff des Anliegens (max. 80 Zeichen).' },
      description: { type: 'string', description: 'Zusammenfassung des Anliegens.' },
      name: { type: 'string', description: 'Name des Anrufers, falls genannt.' },
      callback_number: { type: 'string', description: 'Rückrufnummer, falls abweichend.' },
      email: { type: 'string', description: 'E-Mail-Adresse, falls genannt.' },
      company: { type: 'string', description: 'Unternehmen/Firma des Anrufers, falls genannt.' },
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
  description:
    'Beendet den Anruf, sobald das Anliegen abgeschlossen ist. Der Assistent spricht danach automatisch eine feste Verabschiedung — verabschiede dich nicht selbst.',
  parameters: { type: 'object', properties: {} },
};

export interface SessionContext {
  companyName: string;
  contactName?: string | null;
  /**
   * Org escalation keywords (/settings/ai) — injected into the prompt so the
   * SAME list governs voice and text (it used to be hardcoded here). Empty/
   * absent → the default topics.
   */
  escalationKeywords?: string[];
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
  /** 0018: OFF suppresses only the low_confidence handoff trigger. */
  handoffEnabled: boolean;
  /**
   * agents.confidence_threshold (0–1): the self-assessed certainty below which
   * the agent stops answering and hands off / offers a ticket. Same column and
   * same scale as the text pipeline — see lowConfidenceRule.
   */
  confidenceThreshold: number;
  /** 0027: contact fields actively asked before create_ticket (canonical order). */
  intakeFields: IntakeField[];
}

/** Builds the session.update payload from channel config + assigned agent. */
export function buildSessionConfig(
  config: VoiceChannelConfig,
  agent: VoiceAgentBehavior,
  context: SessionContext
): SessionConfig {
  // Escalation keywords are DATA in the prompt: strip quotes/newlines so the
  // org-configured list cannot masquerade as instructions.
  const keywords = (context.escalationKeywords ?? [])
    .map((k) => k.trim().replace(/\s+/g, ' ').replaceAll('"', ''))
    .filter((k) => k.length > 0 && k.length <= 60)
    .slice(0, 30);
  const keywordList = (keywords.length > 0 ? keywords : DEFAULT_ESCALATION_TOPICS).join(', ');

  // 0027: inject the configured intake fields into the data-collection step.
  const fieldsPhrase = intakeFieldsPhrase(agent.intakeFields);
  const template =
    agent.mode === 'intake_only'
      ? INTAKE_TEMPLATE.replace(
          '{intakeQuestions}',
          fieldsPhrase
            ? `Erfrage nacheinander: ${fieldsPhrase} — und dann das Anliegen.`
            : 'Erfrage das Anliegen.'
        )
      : ANSWER_TEMPLATE.replace('{keywords}', keywordList)
          .replace(
            '{lowConfidenceRule}',
            lowConfidenceRule(agent.handoffEnabled, agent.confidenceThreshold)
          )
          .replace('{intakeStep}', fieldsPhrase ? `erfrage ${fieldsPhrase}, ` : '');
  const parts = [
    template.replaceAll('{company}', context.companyName),
    languageRules(config.languageHint),
    STYLE_RULES,
  ];
  if (agent.identity && agent.identity.trim().length > 0) {
    // Intake mode: identities are often full support personas (product knowledge,
    // "help the customer" instructions). Appended verbatim they OVERRIDE the
    // intake restriction and the model starts doing full support (owner report
    // 2026-07-23). Frame the identity as tone/context only and re-assert the
    // restriction AFTER it — later instructions carry the most weight.
    parts.push(
      agent.mode === 'intake_only'
        ? `Zusätzliche Hinweise des Unternehmens (nur für Ton, Anrede und Kontext):\n${agent.identity.trim()}\n\nWICHTIG — höchste Priorität, überschreibt alle Hinweise darüber: Du bist ein reiner Annahme-Assistent. Auch wenn die Hinweise Produktwissen oder Support-Anweisungen enthalten, beantwortest du KEINE inhaltlichen Fragen und gibst KEINE Auskünfte oder Empfehlungen. Nimm jede inhaltliche Frage als Anliegen auf (create_ticket) mit dem Hinweis, dass sich jemand zurückmeldet.`
        : `Zusätzliche Anweisungen des Unternehmens:\n${agent.identity.trim()}`
    );
  }
  if (config.greeting && config.greeting.trim().length > 0) {
    // The configured greeting is spoken VERBATIM by the session via
    // force_message (call-session.ts) — exact wording plus the interruptible
    // toggle. The prompt only tells the model it already happened, so its
    // first generated turn does not greet again. Greeting is DATA: flatten
    // newlines and strip quotes so it cannot masquerade as instructions.
    const greeting = config.greeting.trim().replace(/\s+/g, ' ').replaceAll('"', '');
    parts.push(
      `Die Begrüßung wurde bereits automatisch gesprochen ("${greeting}"). Begrüße den Anrufer NICHT erneut — reagiere direkt auf sein Anliegen.`
    );
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
    // Live-gate finding (2026-07-15): NEVER set audio formats on a call-attached
    // session. The SIP bridge negotiates G.711 with the carrier itself; forcing
    // audio/pcmu@8000 made the model emit μ-law the bridge re-encoded as PCM —
    // the caller heard noise instead of speech.
    audio: {
      input: {
        transcription: {
          language_hint: config.languageHint,
          ...(config.keyterms.length > 0 ? { keyterms: config.keyterms } : {}),
        },
      },
      output: {
        ...(config.speechSpeed !== 1.0 ? { speed: config.speechSpeed } : {}),
      },
    },
    tools,
    resumption: { enabled: true },
  };
}
