import type { VoiceChannelConfig } from '@zendori/channels';
import type { EscalationTarget, IntakeField } from '@zendori/core';
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
- Beantworte Fragen NUR auf Basis der Wissensdatenbank: rufe dafür das Werkzeug kb_search auf. Erfinde nichts.
- Wenn die Antwort schon aus dem bisherigen Gespräch bekannt ist (z. B. bereits nachgeschlagen oder eben besprochen), antworte direkt — ohne erneutes Nachschlagen und ohne Ankündigung.
- Kündige das Nachschlagen NICHT rituell an: rufe kb_search in der Regel einfach direkt auf, eine kurze natürliche Pause ist völlig in Ordnung. Wenn du vor einem Nachschlagen doch etwas sagst, halte es sehr kurz und variiere die Formulierung — nie zweimal dieselbe Floskel im selben Gespräch, und versprich niemals routinemäßig „einen kleinen Augenblick".
- Formuliere die Suchanfrage präzise und nutze Produkt- und Eigennamen, wenn der Anrufer welche genannt hat. Liefert die Suche nichts Passendes, versuche genau EINE zweite Suche mit anderen Begriffen (Synonym, Produktname, Oberbegriff), bevor du sagst, dass du es nicht weißt.
{humanRules}
{lowConfidenceRule}
- Nimm bei Bedarf ein Anliegen strukturiert auf: {intakeStep}fasse das Anliegen zusammen, bestätige es und rufe dann create_ticket auf.
{intakeRules}
{callbackRule}
{emailRule}
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

/** The proactive ticket offer, worded once (owner defect #3, 2026-09-03). */
const OFFER_TICKET_YOURSELF =
  'biete im selben Satz von dir aus an, das Anliegen aufzunehmen, damit sich ein Mitarbeiter meldet („… ich nehme Ihr Anliegen aber gerne auf, dann meldet sich ein Kollege bei Ihnen. Möchten Sie das?"). Warte nicht, bis der Anrufer danach fragt; sagt er ja, beginnst du sofort mit der Aufnahme (create_ticket).';

/**
 * Does uncertainty escalate to handoff_human? Only with the handoff toggle ON
 * and a threshold above 0 — threshold 0 means "never hand off just because you
 * are unsure" (a "below 0" rule would be vacuous). The kb_search miss
 * instruction in tools.ts uses the SAME predicate so prompt and tool output
 * never prescribe different tools for the same situation (review 2026-09-03).
 */
export function escalatesLowConfidence(handoffEnabled: boolean, threshold: number): boolean {
  return handoffEnabled && threshold > 0;
}

/**
 * Keyword / "I want a human" bullets of the answer template, per target
 * (Phase 12): under 'ticket' the same tool call happens, but the model must
 * never promise a live connection — the tool takes a callback intake.
 */
function humanRequestRules(target: EscalationTarget, keywordList: string): string {
  const base = [
    '- Wenn der Anrufer ausdrücklich einen Menschen sprechen möchte, rufe handoff_human mit reason="user_request" auf.',
    `- Bei den Themen ${keywordList} rufe handoff_human mit reason="keyword" auf.`,
  ];
  if (target === 'ticket') {
    base.push(
      '- Sage dabei ehrlich, dass du das Anliegen aufnimmst und sich ein Mitarbeiter zurückmeldet — versprich keine sofortige Verbindung oder Weiterleitung.'
    );
  }
  return base.join('\n');
}

/** The intake template's "wants a human" sentence, per target. */
function userRequestRule(target: EscalationTarget): string {
  return target === 'ticket'
    ? 'Wenn der Anrufer ausdrücklich sofort einen Menschen sprechen möchte, erkläre ehrlich, dass gerade keine direkte Verbindung möglich ist, und rufe handoff_human mit reason="user_request" auf — das Anliegen wird als Rückruf aufgenommen.'
    : 'Wenn der Anrufer ausdrücklich sofort einen Menschen sprechen möchte, rufe handoff_human mit reason="user_request" auf.';
}

/**
 * The low_confidence bullet depends on the agent's handoff toggle (0018) and
 * its confidence threshold: escalating → hand uncertainty below the threshold
 * to handoff_human (the tool then decides live transfer vs. callback ticket
 * and its callback instruction already carries the ticket offer); not
 * escalating → admit the limit and offer the ticket yourself (handoffTool
 * additionally refuses reason='low_confidence' server-side — the prompt is
 * UX, the tool is the guarantee). Every variant carries the "never just say
 * you don't know" rule — in the owner's test the agent stopped at "kann ich
 * nicht sagen" and the caller had to ask for a ticket himself.
 */
function lowConfidenceRule(
  handoffEnabled: boolean,
  threshold: number,
  target: EscalationTarget = 'human'
): string {
  if (threshold <= 0) {
    return `- Übergib NICHT allein wegen Unsicherheit an einen Menschen (rufe dafür nicht handoff_human auf). Antworte so gut, wie die Wissensdatenbank es zulässt. Liefert sie wirklich nichts, sage NIEMALS nur, dass du es nicht weißt — sage das ehrlich und ${OFFER_TICKET_YOURSELF}`;
  }
  const t = formatThreshold(threshold);
  return escalatesLowConfidence(handoffEnabled, threshold)
    ? `- ${CONFIDENCE_SCALE} Liegt dein Wert unter ${t}, antworte NICHT inhaltlich, sondern rufe handoff_human mit reason="low_confidence" auf — das gilt auch, wenn die Wissensdatenbank gar nichts liefert. Sage dabei ehrlich, dass du das gerade nicht beantworten kannst, NIEMALS nur „das weiß ich nicht"; ${
        target === 'ticket'
          ? 'das Werkzeug leitet dich danach durch die Aufnahme eines Rückrufs'
          : 'das Werkzeug sagt dir danach, ob weitergeleitet wird oder du einen Rückruf aufnimmst'
      }. Warte nicht, bis der Anrufer nach einem Mitarbeiter fragt. Bei ${t} oder höher antwortest du selbst.`
    : `- ${CONFIDENCE_SCALE} Liegt dein Wert unter ${t}, antworte NICHT inhaltlich und rufe auch NICHT handoff_human auf — das gilt auch, wenn die Wissensdatenbank gar nichts liefert. Sage NIEMALS nur, dass du es nicht weißt: sage ehrlich, dass du das gerade nicht sicher sagen kannst, und ${OFFER_TICKET_YOURSELF} Bei ${t} oder höher antwortest du selbst.`;
}

/** Re-asserted after the org identity so persona text cannot override the intake setting. */
const INTAKE_RULES_TRAILER =
  'Unabhängig von den Hinweisen des Unternehmens gelten die Vorgaben zur Anliegen-Aufnahme oben unverändert: Du erfragst nur die dort genannten Angaben (und die dort ausgeschlossenen NICHT), und E-Mail-Adressen übernimmst du nur buchstabiert und bestätigt.';

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

/** Short labels for the "frage NICHT nach …" list (the long phrases read oddly there). */
const INTAKE_FIELD_SHORT: Record<IntakeField, string> = {
  name: 'Name',
  phone: 'Rückrufnummer',
  email: 'E-Mail-Adresse',
  company: 'Unternehmen',
};
const ALL_INTAKE_FIELDS: IntakeField[] = ['name', 'phone', 'email', 'company'];

function joinSpoken(parts: string[], conjunction: 'und' | 'noch' = 'und'): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} ${conjunction} ${parts[parts.length - 1]!}`;
}

/**
 * Spoken-German enumeration of the configured intake fields ("Name,
 * E-Mail-Adresse und …"). Empty selection → empty string (callers of this
 * helper phrase their sentence without an "erfrage" part then).
 */
export function intakeFieldsPhrase(fields: IntakeField[]): string {
  return joinSpoken(fields.map((f) => INTAKE_FIELD_PHRASES[f]));
}

/**
 * The explicit ask/do-not-ask rule for ticket intake. A positive list alone
 * was not enough (owner test 2026-09-03: the agent asked for the e-mail
 * address although only name+phone were configured — the tool schema offers
 * every field, so the model asks for what it sees). Naming the NOT-configured
 * fields explicitly closes that gap; volunteered data is still captured.
 */
export function intakeFieldRules(fields: IntakeField[]): string {
  const asked = new Set(fields);
  const notAsked = ALL_INTAKE_FIELDS.filter((f) => !asked.has(f));
  const volunteered =
    'Nennt der Anrufer solche Angaben von selbst, übernimm sie — erfragen darfst du sie nicht.';
  if (fields.length === 0) {
    return `- Erfrage für die Aufnahme KEINE Kontaktdaten (weder ${joinSpoken(
      ALL_INTAKE_FIELDS.map((f) => INTAKE_FIELD_SHORT[f]),
      'noch'
    )}) — nur das Anliegen selbst. ${volunteered}`;
  }
  const positive = `- Erfrage für die Aufnahme ausschließlich: ${intakeFieldsPhrase(fields)}.`;
  if (notAsked.length === 0) return positive;
  return `${positive} Frage NICHT nach ${joinSpoken(
    notAsked.map((f) => INTAKE_FIELD_SHORT[f])
  )} — auch nicht „zur Sicherheit" oder „für die Rückmeldung". ${volunteered}`;
}

/**
 * Spoken e-mail capture is error-prone (owner test 2026-09-03: a mis-heard
 * address landed on the contact). The rule applies to asked AND volunteered
 * addresses; createTicketTool additionally refuses an email without
 * email_confirmed=true, so the spell-back is not prompt-only.
 */
/**
 * Caller-id for speech (0029): "+491701234567" → "0170 123 4567". German
 * numbers lose the country code (callers know their number as 0…), other
 * countries keep "+CC"; digits are grouped in threes after the prefix so the
 * model reads them in natural chunks. Non-numeric input is returned as-is.
 */
// ITU E.164: +1/+7 are the only one-digit country codes; these are the
// two-digit ones, everything else is three digits.
const TWO_DIGIT_CC = /^\+(2[07]|3[0-469]|4[013-9]|5[1-8]|6[0-6]|8[1246]|9[0-58])/;
// German area codes with two digits (Berlin, Hamburg, Frankfurt, München) —
// everything else is read with a four-character prefix ("0170", "0211"), which
// is right for mobiles and three-digit area codes; a rare longer area code is
// merely grouped differently, the digits stay correct.
const DE_TWO_DIGIT_AREA = /^0(30|40|69|89)/;

export function formatPhoneForSpeech(raw: string): string {
  const compact = raw.replace(/[^\d+]/g, '');
  if (!/^\+?\d{4,}$/.test(compact)) return raw.trim();
  let prefix: string;
  let rest: string;
  const nationalDe = compact.startsWith('+49')
    ? `0${compact.slice(3)}`
    : compact.startsWith('0')
      ? compact
      : null;
  if (nationalDe) {
    const len = DE_TWO_DIGIT_AREA.test(nationalDe) ? 3 : 4;
    prefix = nationalDe.slice(0, len);
    rest = nationalDe.slice(len);
  } else {
    const cc = compact.match(/^\+[17]/)?.[0] ?? compact.match(TWO_DIGIT_CC)?.[0] ?? compact.slice(0, 4);
    prefix = cc;
    rest = compact.slice(cc.length);
  }
  const groups = rest.match(/\d{1,3}/g) ?? [];
  // a lone trailing digit reads badly ("… 456 7") — fold it into the last group
  if (groups.length > 1 && groups[groups.length - 1]!.length === 1) {
    const tail = groups.pop()!;
    groups[groups.length - 1] += tail;
  }
  return [prefix, ...groups].join(' ').trim();
}

/**
 * The callback-number step (0029). The system always knew the caller id (SIP
 * From → contacts.phone) but the model never did, so it could only ask
 * generically for "die Rückrufnummer". Now it confirms the known number and
 * asks for an alternative only if the caller wants one; an anonymous caller
 * is asked outright. Without 'phone' in the intake fields the number is only
 * context (the do-not-ask rule stays in force). Empty string = no bullet.
 */
export function callbackNumberRule(
  fields: IntakeField[],
  callerNumber: string | null | undefined
): string {
  const asksPhone = fields.includes('phone');
  const spoken = callerNumber ? formatPhoneForSpeech(callerNumber) : null;
  const confirmStep =
    'wiederhole sie in Zifferngruppen, warte auf sein Ja und übergib sie erst dann als callback_number mit callback_confirmed=true';
  if (asksPhone && spoken) {
    return `- Rückrufnummer: Der Anrufer ruft von ${spoken} an. Frage: „Dürfen wir Sie unter der Nummer zurückrufen, von der Sie gerade anrufen — ${spoken}?" Sagt er ja, setzt du use_caller_number=true und KEINE callback_number (die Anrufnummer gilt). Nennt er eine andere Nummer, ${confirmStep}.`;
  }
  if (asksPhone) {
    return `- Rückrufnummer: Die Anrufnummer ist unterdrückt — erfrage die Rückrufnummer, ${confirmStep}.`;
  }
  if (spoken) {
    return `- Der Anrufer ruft von ${spoken} an; ein Rückruf geht an diese Nummer, frage nicht danach. Nennt er von sich aus eine andere Nummer, ${confirmStep}.`;
  }
  return '';
}

export const EMAIL_CAPTURE_RULE =
  '- E-Mail-Adressen (erfragt oder vom Anrufer genannt) übernimmst du nur bestätigt: wiederhole die GESAMTE Adresse Buchstabe für Buchstabe — auch den Teil nach dem @-Zeichen —, sage „at" für das @-Zeichen, „Punkt" für den Punkt, „Minus" für den Bindestrich und „Unterstrich" für den Unterstrich. Einzige Ausnahme: geläufige Domains wie gmail.com, gmx.de, web.de oder t-online.de darfst du als Wort sagen. Frage dann, ob das so richtig ist. Erst nach einem klaren Ja übergibst du die Adresse an create_ticket (email_confirmed=true). Korrigiert der Anrufer, wiederhole die Buchstabierung.';

const INTAKE_TEMPLATE = `Du bist der telefonische Annahme-Assistent von {company}. Deine einzige Aufgabe ist es, Anliegen aufzunehmen — du beantwortest KEINE inhaltlichen Fragen.
Sprich natürlich, kurz und klar (Höflichkeitsform). Du telefonierst — halte dich kurz, keine Aufzählungen.

Ablauf:
1. Begrüße den Anrufer und erkläre, dass du sein Anliegen aufnimmst und sich jemand zurückmeldet.
2. {intakeQuestions}
3. Fasse alles in ein bis zwei Sätzen zusammen und lass es dir bestätigen.
4. Rufe create_ticket mit den erfassten Daten auf.
5. Bestätige die Aufnahme mit einem vollständigen, freundlichen Satz („Ihr Anliegen ist aufgenommen — wir melden uns schnellstmöglich zurück.") und rufe DANN end_call auf. Die Verabschiedung spricht das System danach automatisch — verabschiede dich nicht selbst. Beende niemals mitten im Satz.

{intakeRules}
{callbackRule}
{emailRule}

{userRequestRule}
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
- Sprich NIEMALS über interne Technik: keine "Wissensdatenbank", keine "Datenbank", kein "System", keine Werkzeug- oder Funktionsnamen. Du "schaust kurz nach" oder "prüfst das" — mehr sagst du dazu nicht.
- Nenne niemals Ticketnummern, IDs, Kennungen oder Referenzen — es gibt keine, die der Anrufer bräuchte. „Ihr Anliegen ist aufgenommen" genügt.`;

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

/**
 * create_ticket keeps every optional contact parameter regardless of the
 * configured intake fields (volunteered data must still land), but the
 * parameter DESCRIPTIONS say per session whether a field was asked for or may
 * only be filled from what the caller volunteered — the schema is the second
 * place (next to the prompt) where the model learns what not to ask.
 */
export function buildCreateTicketTool(
  fields: IntakeField[],
  callerNumber?: string | null
): FunctionTool {
  const asked = new Set(fields);
  const contactParam = (field: IntakeField, base: string) => ({
    type: 'string' as const,
    description: asked.has(field)
      ? `${base} — wie erfragt.`
      : `${base} — NUR wenn der Anrufer sie unaufgefordert genannt hat; nicht erfragen.`,
  });
  return {
    type: 'function',
    name: 'create_ticket',
    description:
      'Nimmt das Anliegen des Anrufers als Ticket auf. Vorher das Anliegen zusammenfassen und bestätigen lassen; erfrage ausschließlich die in den Anweisungen vorgegebenen Angaben. Liefert keine Ticketnummer — nenne dem Anrufer keine Kennung.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Kurzer Betreff des Anliegens (max. 80 Zeichen).' },
        description: { type: 'string', description: 'Zusammenfassung des Anliegens.' },
        name: contactParam('name', 'Name des Anrufers'),
        callback_number: contactParam(
          'phone',
          callerNumber
            ? `Rückrufnummer NUR, wenn sie von der Anrufnummer ${formatPhoneForSpeech(callerNumber)} abweicht — sonst weglassen`
            : 'Rückrufnummer (die Anrufnummer ist unterdrückt)'
        ),
        callback_confirmed: {
          type: 'boolean',
          description:
            'Pflicht, sobald callback_number gesetzt ist: true NUR, wenn du die Nummer in Zifferngruppen wiederholt hast und der Anrufer sie ausdrücklich bestätigt hat. Ohne Bestätigung wird das Ticket abgelehnt.',
        },
        use_caller_number: {
          type: 'boolean',
          description: callerNumber
            ? `true, wenn der Anrufer bestätigt hat, dass wir ihn unter der Anrufnummer ${formatPhoneForSpeech(callerNumber)} zurückrufen dürfen (dann keine callback_number).`
            : 'Nicht verwenden — die Anrufnummer ist unterdrückt.',
        },
        email: contactParam('email', 'E-Mail-Adresse'),
        email_confirmed: {
          type: 'boolean',
          description:
            'Pflicht, sobald email gesetzt ist: true NUR, wenn du die Adresse buchstabiert wiederholt hast und der Anrufer sie ausdrücklich bestätigt hat. Ohne Bestätigung wird das Ticket abgelehnt.',
        },
        company: contactParam('company', 'Unternehmen/Firma des Anrufers'),
      },
      required: ['subject', 'description'],
    },
  };
}

/** handoff_human per target (Phase 12): under 'ticket' there is no transfer — ever. */
export function buildHandoffTool(target: EscalationTarget): FunctionTool {
  return {
    type: 'function',
    name: 'handoff_human',
    description:
      target === 'ticket'
        ? 'Nimmt das Anliegen für einen Rückruf durch einen Mitarbeiter auf, wenn du nicht weiterkommst oder der Anrufer einen Menschen wünscht. Es gibt KEINE Weiterleitung — versprich niemals, jetzt zu verbinden.'
        : 'Übergibt das Gespräch an einen menschlichen Mitarbeiter (Weiterleitung oder Rückruf).',
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
}

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
  /** Caller id (contacts.phone from the SIP From header); null/absent = withheld. */
  callerNumber?: string | null;
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
  /** 0031: 'ticket' = no human live — callback intake instead of transfer/handoff. */
  escalationTarget: EscalationTarget;
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
  const template = (
    agent.mode === 'intake_only'
      ? INTAKE_TEMPLATE.replace(
          '{intakeQuestions}',
          fieldsPhrase
            ? `Erfrage nacheinander: ${fieldsPhrase} — und dann das Anliegen.`
            : 'Erfrage das Anliegen.'
        )
      : ANSWER_TEMPLATE.replace('{humanRules}', humanRequestRules(agent.escalationTarget, keywordList))
          .replace(
            '{lowConfidenceRule}',
            lowConfidenceRule(agent.handoffEnabled, agent.confidenceThreshold, agent.escalationTarget)
          )
          .replace('{intakeStep}', fieldsPhrase ? `erfrage ${fieldsPhrase}, ` : '')
  )
    .replace('{userRequestRule}', userRequestRule(agent.escalationTarget))
    .replace('{intakeRules}', intakeFieldRules(agent.intakeFields))
    .replace('{callbackRule}', callbackNumberRule(agent.intakeFields, context.callerNumber))
    .replace('{emailRule}', EMAIL_CAPTURE_RULE)
    // an empty callback rule must not leave a blank bullet line behind
    .replace(/\n\n(?=- E-Mail-Adressen)/, '\n')
    .replace(/\n\n(?=- E-Mail-Adressen)/, '\n');
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
        : `Zusätzliche Hinweise des Unternehmens (Rolle, Ton, Anrede und Fachkontext):\n${agent.identity.trim()}`
    );
    // The structured intake setting must beat free-text persona lines ("frag
    // immer nach der E-Mail-Adresse" is a common one). Later instructions
    // carry the most weight — same mechanism the intake fence above relies on.
    parts.push(INTAKE_RULES_TRAILER);
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

  const createTicketTool = buildCreateTicketTool(agent.intakeFields, context.callerNumber);
  const handoffTool = buildHandoffTool(agent.escalationTarget);
  const tools: FunctionTool[] =
    agent.mode === 'intake_only'
      ? [createTicketTool, handoffTool, END_CALL_TOOL]
      : [KB_SEARCH_TOOL, createTicketTool, handoffTool, END_CALL_TOOL];

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
