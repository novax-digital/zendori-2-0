import { z } from 'zod';
import { retrieveRelevantChunks, EMBEDDING_MODEL } from '@zendori/ai';
import { isKbImageFilename, type IntakeField, type SupabaseClient } from '@zendori/core';
import {
  hasConfiguredHours,
  isWithinBusinessHours,
  type BusinessHours,
  type VoiceChannelConfig,
} from '@zendori/channels';
import { isMissingColumnError } from '../db.js';
import { escalatesLowConfidence, intakeFieldsPhrase } from './session-config.js';

// Voice function-tool handlers. All run in the worker with the org_id bound
// from the voice_calls row (server truth — never from the model), so RLS-scoped
// tenant isolation holds (§7/§9). Each returns a JSON-serializable object that
// is sent back as the function_call_output. Tool arguments arrive as a JSON
// string from the model — parsed + zod-validated here, never trusted.

export interface ToolContext {
  supabase: SupabaseClient;
  orgId: string;
  conversationId: string;
  channelId: string;
  channelConfig: VoiceChannelConfig;
  /** Resolved from the assigned agent (0011): gates kb_search in intake mode. */
  agentMode: 'answer' | 'intake_only';
  /** Agent's linked knowledge bases (0012): null = all, [] = none. */
  knowledgeBaseIds: string[] | null;
  /** 0018: OFF suppresses only the low_confidence handoff trigger. */
  handoffEnabled: boolean;
  /** agents.confidence_threshold — with handoffEnabled decides whether a miss escalates. */
  confidenceThreshold: number;
  /** 0027: contact fields the agent asks for during ticket intake. */
  intakeFields: IntakeField[];
  /**
   * Number of caller utterances heard so far (CallSession counts transcription
   * items). The e-mail spell-back gate uses it to require that the caller
   * actually spoke between a refusal and the confirmed retry.
   */
  callerTurns: number;
  /** Session-owned, mutable: refusal bookkeeping for the e-mail gate. */
  emailGate: ConfirmGateState;
  /** Session-owned, mutable: refusal bookkeeping + identity memo for the callback-number gate. */
  phoneGate: PhoneGateState;
  /** Caller id (contacts.phone from SIP From); null = withheld. Steers callback storage. */
  callerNumber: string | null;
  /**
   * Org business hours (defensively parsed) — the live-transfer gate is
   * evaluated HERE at tool-call time, not at call start, so the mid-call
   * boundary (call starts 16:58, handoff 17:02) is correct by construction.
   */
  businessHours: BusinessHours | null;
  /**
   * Explicit transfer permission: false in the agent-less safe-intake fallback
   * (no owner-configured behavior → never transfer). Deliberately its own flag
   * — overloading businessHours=null would give null two meanings.
   */
  allowTransfer: boolean;
  /**
   * 0025 memo: ids of this org's image sources, filled on the first kb_search of
   * a call. Image descriptions are excluded from voice results — see
   * loadImageSourceIds.
   */
  imageSourceIds?: Set<string>;
}

export type ToolResult = { ok: true; [key: string]: unknown } | { ok: false; error: string };

/**
 * Spell-back confirmation gate state, one per call and per field (created by
 * CallSession, mutated here). Used for the e-mail address and the callback
 * number — both are model-transcribed from speech.
 */
export interface ConfirmGateState {
  refusals: number;
  /** callerTurns at the last refusal — a confirmed retry needs a later turn. */
  refusedAtTurn: number | null;
}
export function newConfirmGateState(): ConfirmGateState {
  return { refusals: 0, refusedAtTurn: null };
}
/** Phone gate additionally remembers a phone THIS call wrote as the contact identity. */
export interface PhoneGateState extends ConfirmGateState {
  /** contacts.phone value this call gap-filled for an anonymous caller (correctable in-call). */
  identityPhoneWritten: string | null;
}
export function newPhoneGateState(): PhoneGateState {
  return { refusals: 0, refusedAtTurn: null, identityPhoneWritten: null };
}
/** After this many refusals the ticket goes through WITHOUT the field (loop guard). */
export const CONFIRM_GATE_MAX_REFUSALS = 3;

/**
 * Shared gate logic: a value counts as confirmed only with the flag AND a
 * caller turn after the last refusal; invalid values are refused as well.
 * Returns the refusal error, or null when the value may be used / dropped.
 */
function runConfirmGate(
  gate: ConfirmGateState,
  callerTurns: number,
  confirmedFlag: boolean,
  valid: boolean,
  errors: { unconfirmed: string; invalid: string }
): { error: string } | { drop: boolean } {
  const callerSpokeSinceRefusal = gate.refusedAtTurn === null || callerTurns > gate.refusedAtTurn;
  const confirmed = confirmedFlag && callerSpokeSinceRefusal;
  if (confirmed && valid) return { drop: false };
  gate.refusals += 1;
  gate.refusedAtTurn = callerTurns;
  if (gate.refusals < CONFIRM_GATE_MAX_REFUSALS) {
    return { error: confirmed ? errors.invalid : errors.unconfirmed };
  }
  return { drop: true };
}

const KB_SNIPPET_MAX_CHARS = 800;

const kbSearchArgsSchema = z.object({ query: z.string().min(1).max(2000) });

export async function kbSearchTool(ctx: ToolContext, rawArgs: unknown): Promise<ToolResult> {
  const parsed = kbSearchArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: 'invalid arguments' };
  if (ctx.agentMode === 'intake_only') {
    return { ok: false, error: 'kb_search ist in diesem Modus nicht verfügbar' };
  }

  const start = Date.now();
  // Hybrid stage only — the Haiku rerank would add ~1s of silence to a live
  // call; the caller's short spoken questions are exactly where the keyword
  // leg shines anyway. Smaller pool keeps the tool result compact.
  const { matches, embedCostUsd, searchMode } = await retrieveRelevantChunks(
    ctx.supabase,
    ctx.orgId,
    parsed.data.query,
    // minSimilarity 0.3: without the rerank noise filter, voice keeps the
    // legacy vector cutoff (0014) — the 0.15 gate is only safe WITH reranking.
    {
      knowledgeBaseIds: ctx.knowledgeBaseIds,
      poolCount: 12,
      finalCount: 6,
      rerank: false,
      minSimilarity: 0.3,
    }
  );
  await ctx.supabase.from('ai_runs').insert({
    org_id: ctx.orgId,
    conversation_id: ctx.conversationId,
    step: 'retrieve',
    model: EMBEDDING_MODEL,
    latency_ms: Date.now() - start,
    cost_usd: embedCostUsd,
    input_summary: 'voice.kb_search',
    output_summary: `matches=${matches.length} mode=${searchMode}`,
  });

  // Drop passages that came from an image (0025). Their text describes what a
  // picture LOOKS like ("der rote Kreis markiert den Reset-Knopf links unten"),
  // which a live caller cannot see — read aloud it is confusing at best. Voice
  // has no way to show the image either. One indexed query per call, cached on
  // the context; pure CPU inside the tool call, so no added silence.
  const imageSourceIds = await loadImageSourceIds(ctx);
  const usable =
    imageSourceIds.size === 0 ? matches : matches.filter((m) => !imageSourceIds.has(m.source_id));

  if (usable.length === 0) {
    // Owner test 2026-09-03: on a miss the model said "kann ich nicht sagen"
    // and stopped — the caller had to ask for a ticket himself. The empty
    // result now carries the next step, so it happens at the exact moment of
    // the miss. Same predicate as the prompt's lowConfidenceRule: with handoff
    // on, a miss is the §6 low-confidence trigger (handoff_human decides live
    // transfer vs. callback ticket and its callback instruction already
    // carries the ticket offer); otherwise the agent offers the ticket itself.
    const escalate = escalatesLowConfidence(ctx.handoffEnabled, ctx.confidenceThreshold);
    return {
      ok: true,
      chunks: [],
      instruction: escalate ? KB_MISS_INSTRUCTION_HANDOFF : KB_MISS_INSTRUCTION,
    };
  }
  return {
    ok: true,
    chunks: usable.map((m) => ({
      content: m.content.slice(0, KB_SNIPPET_MAX_CHARS),
      source_id: m.source_id,
    })),
  };
}

/** Next step after a knowledge-base miss when uncertainty does NOT escalate (see kbSearchTool). */
export const KB_MISS_INSTRUCTION =
  'Nichts Passendes gefunden. Falls du noch keine zweite Suche mit anderen Begriffen versucht hast, versuche jetzt genau eine. Sonst: sage ehrlich, dass du dazu keine Information hast, und biete im selben Satz von dir aus an, das Anliegen aufzunehmen (create_ticket), damit sich ein Mitarbeiter meldet — warte nicht, bis der Anrufer danach fragt.';
/** Next step after a miss when uncertainty escalates (handoff on, threshold > 0). */
export const KB_MISS_INSTRUCTION_HANDOFF =
  'Nichts Passendes gefunden. Falls du noch keine zweite Suche mit anderen Begriffen versucht hast, versuche jetzt genau eine. Sonst: antworte NICHT inhaltlich, sage ehrlich, dass du das gerade nicht beantworten kannst, und rufe im selben Zug handoff_human mit reason="low_confidence" auf — das Werkzeug sagt dir danach, ob weitergeleitet wird oder du einen Rückruf aufnimmst. Warte nicht, bis der Anrufer nach einem Mitarbeiter fragt.';

/**
 * Ids of this org's image sources, resolved once per call and memoised on the
 * tool context. Identified by file extension rather than a marker in the chunk
 * text: the "Quelle: …" header format is a chunking detail that must not become
 * load-bearing here.
 */
async function loadImageSourceIds(ctx: ToolContext): Promise<Set<string>> {
  if (ctx.imageSourceIds) return ctx.imageSourceIds;
  const ids = new Set<string>();
  try {
    const { data } = await ctx.supabase
      .from('kb_sources')
      .select('id, uri')
      .eq('org_id', ctx.orgId)
      .eq('type', 'file');
    for (const row of (data ?? []) as { id: string; uri: string | null }[]) {
      if (isKbImageFilename(row.uri ?? '')) ids.add(row.id);
    }
  } catch {
    // On failure prefer answering with everything over failing the call.
  }
  ctx.imageSourceIds = ids;
  return ids;
}

const createTicketArgsSchema = z.object({
  subject: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
  name: z.string().max(200).optional(),
  callback_number: z.string().max(50).optional(),
  /** Spell-back confirmation flag for callback_number (same gate as the e-mail). */
  callback_confirmed: z.boolean().optional(),
  /** Caller confirmed "call me on the number I am calling from" — clears a stale callback_phone. */
  use_caller_number: z.boolean().optional(),
  email: z.string().max(200).optional(),
  /** Spell-back confirmation flag — required whenever email is set (see below). */
  email_confirmed: z.boolean().optional(),
  company: z.string().max(200).optional(),
});

/**
 * Sent back when create_ticket carries an unconfirmed e-mail: the model has
 * to spell the address back, get a yes, and call again. Nothing is written
 * before this gate — a mis-heard address must never reach contacts.email
 * (replies would go to a stranger).
 */
export const EMAIL_UNCONFIRMED_ERROR =
  'E-Mail-Adresse noch nicht bestätigt: wiederhole sie dem Anrufer buchstabiert, warte auf sein Ja und rufe create_ticket danach erneut auf (mit email_confirmed=true). Ohne E-Mail-Adresse darfst du das Ticket jederzeit anlegen.';

/**
 * A confirmed address that is still not a valid e-mail (umlaut, blank, missing
 * @ or TLD): the caller must not hear "aufgenommen" while nothing was stored
 * (review 2026-09-03). Umlauts are deliberately NOT transliterated — guessing
 * ae/oe/ue would produce a plausible but wrong address.
 */
export const EMAIL_INVALID_ERROR =
  'Die bestätigte E-Mail-Adresse ist so nicht gültig (z. B. Umlaut, Leerzeichen, fehlendes @ oder fehlende Endung wie .de). Umlaute werden in E-Mail-Adressen meist als ae/oe/ue geschrieben. Lass die Adresse noch einmal buchstabieren, bestätige sie erneut und rufe create_ticket danach noch einmal auf — oder lege das Ticket ohne E-Mail-Adresse an.';

export const PHONE_UNCONFIRMED_ERROR =
  'Rückrufnummer noch nicht bestätigt: wiederhole sie dem Anrufer in Zifferngruppen, warte auf sein Ja und rufe create_ticket danach erneut auf (mit callback_confirmed=true). Gilt die Anrufnummer, setze stattdessen use_caller_number=true und keine callback_number.';
export const PHONE_INVALID_ERROR =
  'Die bestätigte Rückrufnummer ist keine gültige Telefonnummer (zu kurz oder keine Ziffern). Lass sie noch einmal nennen, wiederhole sie in Zifferngruppen, bestätige sie erneut und rufe create_ticket danach noch einmal auf — oder lege das Ticket ohne Rückrufnummer an.';
export const PHONE_DROPPED_NOTE =
  ' Die Rückrufnummer wurde NICHT gespeichert, weil sie nicht bestätigt werden konnte — sage dem Anrufer kurz, dass wir ihn über die anderen Angaben erreichen.';

/** Appended to the success instruction when the loop guard dropped the address. */
export const EMAIL_DROPPED_NOTE =
  ' Die E-Mail-Adresse wurde NICHT gespeichert, weil sie nicht bestätigt werden konnte — sage dem Anrufer kurz, dass wir ihn über die anderen Angaben erreichen.';

/** Spoken confirmation after a successful create_ticket — deliberately id-free. */
export const TICKET_CREATED_INSTRUCTION =
  'Das Anliegen ist als Ticket aufgenommen. Bestätige das dem Anrufer in einem Satz — nenne KEINE Ticketnummer, Kennung oder Referenz.';

/**
 * The spoken instruction fragment for a callback-ticket flow ("erfrage Name
 * und Rückrufnummer, fasse das Anliegen zusammen") — built from the agent's
 * configured intake fields (0027) so callback flows ask the same data as the
 * regular intake.
 */
export function callbackIntakeStep(fields: IntakeField[]): string {
  const phrase = intakeFieldsPhrase(fields);
  return phrase
    ? `erfrage ${phrase}, fasse das Anliegen zusammen`
    : 'fasse das Anliegen zusammen';
}

/**
 * Spoken numbers arrive with spaces, slashes or dashes ("0170 / 123-4567");
 * store and compare them compact. "00…" becomes "+…"; anything without at
 * least four digits is not a number and is dropped.
 */
export function normalizePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Written trunk-zero notation "+49 (0) 170 …": drop the "(0)" (an area code
  // in parentheses like "(030)" is untouched).
  let compact = raw.replace(/\(\s*0\s*\)/g, '').replace(/[^\d+]/g, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  compact = compact.replace(/(?!^)\+/g, '');
  // Spoken trunk zero after the country code ("plus 49, null 170 …"): German
  // national numbers never start with 0, so it is always stray (+49 only —
  // e.g. Italian +39 0… landlines keep their 0).
  compact = compact.replace(/^\+490/, '+49');
  return /^\+?\d{4,}$/.test(compact) ? compact : undefined;
}

/**
 * Country calling code of the org's own E.164 number ("+4930…" → "+49"), the
 * same prefix heuristic HubSpot's stripCountryCode uses; +49 fallback.
 */
function countryCodeOf(channelNumber: string | undefined): string {
  return channelNumber?.match(/^\+(1|7|\d\d)/)?.[0] ?? '+49';
}

/**
 * National "0…" → E.164 with the channel's country code. contacts.phone is
 * matched by the voice webhook with exact equality against the SIP From
 * number (always "+…"), so anything stored there MUST be E.164 or the caller
 * is never recognised again (review 2026-09-03).
 */
export function toE164(number: string, channelNumber: string | undefined): string {
  if (number.startsWith('+')) return number;
  if (number.startsWith('0')) return `${countryCodeOf(channelNumber)}${number.slice(1)}`;
  return number;
}

/** "+491701234567" and "0170 1234567" are the same number (for the channel's country). */
export function samePhone(a: string, b: string, channelNumber: string | undefined): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  return toE164(na, channelNumber) === toE164(nb, channelNumber);
}

/**
 * The conversation IS the ticket: set subject, fill contact gaps from what the
 * caller said, and add a structured system message so agents see the intake at
 * a glance. Post-call classify/extract refines priority afterwards.
 *
 * Callback number (0029): contacts.phone is the caller id and stays the
 * matching key — a stated number that differs goes to contacts.callback_phone
 * (latest statement wins: the caller explicitly says where to reach them). An
 * anonymous caller's stated number fills the empty phone instead.
 */
export async function createTicketTool(ctx: ToolContext, rawArgs: unknown): Promise<ToolResult> {
  const parsed = createTicketArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: 'invalid arguments' };
  const args = parsed.data;
  // Spell-back gate BEFORE any write (owner test 2026-09-03: a mis-heard
  // address was stored). email_confirmed is model-asserted; two things make it
  // more than a promise: (1) after a refusal the confirmed retry only counts if
  // the caller spoke in between (callerTurns advanced — a silent immediate
  // retry with the flag flipped is refused again), (2) a syntactically invalid
  // address is refused too instead of silently dropped. Both are capped: after
  // EMAIL_GATE_MAX_REFUSALS the ticket goes through WITHOUT the address so a
  // stubborn model can never loop the caller forever.
  const rawEmail = args.email?.trim() || undefined;
  let email: string | undefined;
  let emailDropped = false;
  if (rawEmail) {
    const verdict = runConfirmGate(
      ctx.emailGate,
      ctx.callerTurns,
      args.email_confirmed === true,
      z.email().safeParse(rawEmail).success,
      { unconfirmed: EMAIL_UNCONFIRMED_ERROR, invalid: EMAIL_INVALID_ERROR }
    );
    if ('error' in verdict) return { ok: false, error: verdict.error };
    if (verdict.drop) emailDropped = true;
    else email = rawEmail.toLowerCase();
  }
  // Same gate for a stated callback number (review 2026-09-03: for an anonymous
  // caller a mis-heard number would become the contact identity). A number
  // equal to the caller id needs no confirmation — it is the caller id.
  const rawCallback = args.callback_number?.trim() || undefined;
  const normalizedCallback = normalizePhone(rawCallback);
  const channelNumber = ctx.channelConfig.phoneNumber;
  let callbackNumber: string | undefined;
  let callbackDropped = false;
  let useCallerNumber = args.use_caller_number === true;
  if (
    normalizedCallback &&
    ctx.callerNumber &&
    samePhone(normalizedCallback, ctx.callerNumber, channelNumber)
  ) {
    useCallerNumber = true;
  } else if (rawCallback) {
    const verdict = runConfirmGate(
      ctx.phoneGate,
      ctx.callerTurns,
      args.callback_confirmed === true,
      normalizedCallback !== undefined,
      { unconfirmed: PHONE_UNCONFIRMED_ERROR, invalid: PHONE_INVALID_ERROR }
    );
    if ('error' in verdict) return { ok: false, error: verdict.error };
    if (verdict.drop) callbackDropped = true;
    else callbackNumber = toE164(normalizedCallback!, channelNumber);
  }

  // status='pending' (one-queue principle, 0018): every promised callback —
  // also from the intake/suppressed flows that never flip mode — is visible in
  // the inbox pending queue and covered by the SLA reminder.
  const { error: convError } = await ctx.supabase
    .from('conversations')
    .update({ subject: args.subject, status: 'pending' })
    .eq('org_id', ctx.orgId)
    .eq('id', ctx.conversationId);
  if (convError) return { ok: false, error: 'Ticket konnte nicht gespeichert werden' };

  // Fill contact gaps (never overwrite existing values — mirrors fillContactGaps).
  const { data: convRow } = await ctx.supabase
    .from('conversations')
    .select('contact_id')
    .eq('org_id', ctx.orgId)
    .eq('id', ctx.conversationId)
    .maybeSingle();
  const contactId = (convRow as { contact_id: string | null } | null)?.contact_id;
  const company = args.company?.trim();
  // What the ticket line + contact patch end up saying about the callback.
  let callbackLine: string | null = null;
  if (contactId && (args.name || email || company || callbackNumber || useCallerNumber)) {
    // Column-skew chain: callback_phone is 0029, company is 0027.
    let contactRes = await ctx.supabase
      .from('contacts')
      .select('name, email, phone, company, callback_phone')
      .eq('org_id', ctx.orgId)
      .eq('id', contactId)
      .maybeSingle();
    const callbackColumnMissing = isMissingColumnError(contactRes.error);
    if (callbackColumnMissing) {
      contactRes = (await ctx.supabase
        .from('contacts')
        .select('name, email, phone, company')
        .eq('org_id', ctx.orgId)
        .eq('id', contactId)
        .maybeSingle()) as typeof contactRes;
    }
    const companyColumnMissing = isMissingColumnError(contactRes.error);
    if (companyColumnMissing) {
      contactRes = (await ctx.supabase
        .from('contacts')
        .select('name, email, phone')
        .eq('org_id', ctx.orgId)
        .eq('id', contactId)
        .maybeSingle()) as typeof contactRes;
    }
    const contact = contactRes.data as {
      name: string | null;
      email: string | null;
      phone: string | null;
      company?: string | null;
      callback_phone?: string | null;
    } | null;
    // Gap-only semantics need the current values: a failed read must never be
    // treated as an empty contact (that would overwrite existing data).
    if (!contactRes.error && contact) {
      const patch: Record<string, string | null> = {};
      if (args.name && !contact.name) patch.name = args.name;
      if (email && !contact.email) patch.email = email;
      if (company && !companyColumnMissing && !contact.company) patch.company = company;
      // The caller id applies → a callback_phone from an earlier call is stale
      // (the sidebar and HubSpot would otherwise contradict the ticket line).
      const clearStaleCallback = () => {
        if (!callbackColumnMissing && contact.callback_phone) patch.callback_phone = null;
      };
      const ownIdentityWrite =
        ctx.phoneGate.identityPhoneWritten !== null &&
        contact.phone === ctx.phoneGate.identityPhoneWritten;
      if (callbackNumber) {
        if (!contact.phone || ownIdentityWrite) {
          // anonymous caller: the stated number IS the contact's number — and a
          // number THIS call wrote may be corrected by the same call.
          patch.phone = callbackNumber;
          ctx.phoneGate.identityPhoneWritten = callbackNumber;
          callbackLine = `Rückruf: ${callbackNumber}`;
        } else if (samePhone(callbackNumber, contact.phone, channelNumber)) {
          clearStaleCallback();
          callbackLine = `Rückruf unter Anrufnummer ${contact.phone}`;
        } else {
          if (!callbackColumnMissing && contact.callback_phone !== callbackNumber) {
            patch.callback_phone = callbackNumber;
          }
          callbackLine = `Rückruf: ${callbackNumber} (abweichend von Anrufnummer ${contact.phone})`;
        }
      } else if (contact.phone) {
        if (useCallerNumber) clearStaleCallback();
        callbackLine = `Rückruf unter Anrufnummer ${contact.phone}`;
      }
      if (Object.keys(patch).length > 0) {
        const { error: patchError } = await ctx.supabase
          .from('contacts')
          .update(patch)
          .eq('org_id', ctx.orgId)
          .eq('id', contactId);
        if (
          patchError &&
          isMissingColumnError(patchError) &&
          ('company' in patch || 'callback_phone' in patch)
        ) {
          // Pre-0027/0029 skew: drop the newer columns so the rest still lands.
          delete patch.company;
          delete patch.callback_phone;
          if (Object.keys(patch).length > 0) {
            await ctx.supabase
              .from('contacts')
              .update(patch)
              .eq('org_id', ctx.orgId)
              .eq('id', contactId);
          }
        }
      }
    }
  }
  if (!callbackLine) {
    // No contact row to consult (or nothing stated): fall back to what the
    // session knows about the caller id.
    if (callbackNumber && ctx.callerNumber) {
      callbackLine = `Rückruf: ${callbackNumber} (abweichend von Anrufnummer ${ctx.callerNumber})`;
    } else if (callbackNumber) {
      callbackLine = `Rückruf: ${callbackNumber}`;
    } else if (ctx.callerNumber) {
      callbackLine = `Rückruf unter Anrufnummer ${ctx.callerNumber}`;
    }
  }

  const lines = [
    `Ticket aufgenommen: ${args.subject}`,
    args.description,
    ...(args.name ? [`Name: ${args.name}`] : []),
    ...(company ? [`Unternehmen: ${company}`] : []),
    ...(callbackLine ? [callbackLine] : []),
    ...(email ? [`E-Mail: ${email}`] : []),
  ];
  await ctx.supabase.from('messages').insert({
    org_id: ctx.orgId,
    conversation_id: ctx.conversationId,
    channel_id: ctx.channelId,
    direction: 'out',
    sender_type: 'system',
    content: lines.join('\n'),
    content_type: 'text',
    processing_state: null,
  });

  // No id in the output: the old ticket_ref (a UUID) was read aloud verbatim
  // to the caller (owner test 2026-09-03). The conversation id is server truth
  // the model never needs.
  return {
    ok: true,
    instruction:
      TICKET_CREATED_INSTRUCTION +
      (emailDropped ? EMAIL_DROPPED_NOTE : '') +
      (callbackDropped ? PHONE_DROPPED_NOTE : ''),
  };
}

const handoffArgsSchema = z.object({
  reason: z.enum(['user_request', 'low_confidence', 'keyword']),
});

export type VoiceHandoffDecision = 'transfer' | 'callback' | 'suppress';

export interface DecideVoiceHandoffInput {
  reason: 'user_request' | 'low_confidence' | 'keyword';
  /** agents.handoff_enabled (0018). */
  handoffEnabled: boolean;
  /** Agent-less safe-intake fallback sets this false — never transfer. */
  allowTransfer: boolean;
  /** Voice channel transferNumber (may be absent/blank). */
  transferNumber: string | undefined;
  /** Org business hours; null = never configured. */
  businessHours: BusinessHours | null;
  now: Date;
}

/**
 * The v1 handoff decision matrix (owner decision 2026-07-21), pure:
 * - Toggle OFF suppresses ONLY reason='low_confidence' — user_request and
 *   keyword always hand off (never stonewall an explicit human wish; keywords
 *   are org policy). The reason enum is model-chosen, so this is a best-effort
 *   gate, not a guarantee — documented residual risk.
 * - Live transfer requires: allowed (real agent), a transfer number, and being
 *   within business hours. Hours with NO configured weekday (or null) count as
 *   NOT CONFIGURED → transfer allowed (the number is the opt-in).
 * - Everything else → callback ticket flow.
 */
export function decideVoiceHandoff(input: DecideVoiceHandoffInput): VoiceHandoffDecision {
  if (!input.handoffEnabled && input.reason === 'low_confidence') return 'suppress';
  const number = input.transferNumber?.trim();
  if (!input.allowTransfer || !number) return 'callback';
  const hoursConfigured = hasConfiguredHours(input.businessHours);
  const within = hoursConfigured
    ? isWithinBusinessHours(input.now, input.businessHours!)
    : true; // not configured → the transfer number alone is the opt-in
  return within ? 'transfer' : 'callback';
}

export type HandoffOutcome =
  | { ok: true; action: 'transfer'; transfer_number: string; eventId?: string }
  | { ok: true; action: 'callback'; instruction: string }
  | { ok: true; action: 'no_handoff'; instruction: string }
  | { ok: false; error: string };

/**
 * Insert a handoff event with the 0018 outcome; pre-migration (42703) retries
 * the legacy shape. Returns the new event id when available.
 */
async function insertVoiceHandoffEvent(
  ctx: ToolContext,
  reason: string,
  outcome: string
): Promise<string | null> {
  const { data, error } = await ctx.supabase
    .from('handoff_events')
    .insert({
      org_id: ctx.orgId,
      conversation_id: ctx.conversationId,
      reason,
      outcome,
      triggered_by: null,
    })
    .select('id')
    .single();
  if (error && (error as { code?: string }).code === '42703') {
    await ctx.supabase.from('handoff_events').insert({
      org_id: ctx.orgId,
      conversation_id: ctx.conversationId,
      reason,
      triggered_by: null,
    });
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Hand the conversation to a human (§6 + 0018): decide transfer vs callback vs
 * suppress via the pure matrix above (business hours evaluated NOW), then flip
 * mode/status idempotently (conditional claim on mode='bot' — model retries of
 * handoff_human never produce duplicate events) and record the outcome.
 * The eventId in the transfer outcome is for the CallSession's REFER-result
 * correlation ONLY — it is stripped before the output reaches the model.
 */
export async function handoffTool(ctx: ToolContext, rawArgs: unknown): Promise<HandoffOutcome> {
  const parsed = handoffArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: 'invalid arguments' };
  const reason = parsed.data.reason;

  const decision = decideVoiceHandoff({
    reason,
    handoffEnabled: ctx.handoffEnabled,
    allowTransfer: ctx.allowTransfer,
    transferNumber: ctx.channelConfig.transferNumber,
    businessHours: ctx.businessHours,
    now: new Date(),
  });

  if (decision === 'suppress') {
    // No mode flip, no transfer — but countable (one event per conversation).
    const { data: existing } = await ctx.supabase
      .from('handoff_events')
      .select('id')
      .eq('org_id', ctx.orgId)
      .eq('conversation_id', ctx.conversationId)
      .eq('outcome', 'suppressed')
      .limit(1);
    if (!existing || existing.length === 0) {
      await insertVoiceHandoffEvent(ctx, reason, 'suppressed');
    }
    return {
      ok: true,
      action: 'no_handoff',
      instruction:
        'Eine Übergabe ist hierfür nicht vorgesehen. Sage ehrlich, dass du das gerade nicht beantworten kannst, und biete an, das Anliegen aufzunehmen (create_ticket) — ein Kollege meldet sich dann.',
    };
  }

  // Idempotent claim: only the bot→human transition inserts the event. A
  // duplicate handoff_human (model retry) recomputes the action without a
  // second event.
  const { data: claimed, error: convError } = await ctx.supabase
    .from('conversations')
    .update({ mode: 'human', status: 'pending' })
    .eq('org_id', ctx.orgId)
    .eq('id', ctx.conversationId)
    .eq('mode', 'bot')
    .select('id');
  if (convError) return { ok: false, error: 'Übergabe fehlgeschlagen' };
  const isFirstHandoff = (claimed ?? []).length > 0;

  if (decision === 'transfer') {
    const eventId = isFirstHandoff
      ? await insertVoiceHandoffEvent(ctx, reason, 'pending_human')
      : null;
    return {
      ok: true,
      action: 'transfer',
      transfer_number: ctx.channelConfig.transferNumber!.trim(),
      ...(eventId ? { eventId } : {}),
    };
  }

  if (isFirstHandoff) await insertVoiceHandoffEvent(ctx, reason, 'callback_ticket');
  const hoursConfigured = hasConfiguredHours(ctx.businessHours);
  const outsideHours =
    hoursConfigured && !isWithinBusinessHours(new Date(), ctx.businessHours!);
  const intakeStep = callbackIntakeStep(ctx.intakeFields);
  return {
    ok: true,
    action: 'callback',
    instruction: outsideHours
      ? `Wir sind gerade außerhalb der Geschäftszeiten — kein Live-Transfer. Sage das ehrlich, biete einen Rückruf am nächsten Werktag an: ${intakeStep}, rufe create_ticket auf und beende dann das Gespräch mit end_call.`
      : `Kein Live-Transfer verfügbar. Biete dem Anrufer einen Rückruf an: ${intakeStep}, rufe create_ticket auf und beende dann das Gespräch mit end_call.`,
  };
}
