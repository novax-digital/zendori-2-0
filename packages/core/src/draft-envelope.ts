// The draft model answers inside a small JSON frame — the "envelope":
//
//   {"reply": "<text for the customer>", "confidence": 0.9, "used_source_ids": ["…"]}
//
// Only `reply` is ever meant for a customer. This module is the one place that
// knows how to tell an envelope from an answer and how to take one apart when
// it is NOT valid JSON. Pure, shared by the worker (which stores drafts) and
// the web app (which shows and sends them) — so the frame can never reach a
// customer, whichever side meets it.
//
// Why envelopes break: seen in production from 2026-09 to 2026-11 in about one
// draft in twenty, and in every draft that quotes a button name. The model
// writes a German quotation — „Hörprobe" — with a straight closing quote inside
// the reply and does not escape it, which ends the JSON string early.

export interface DraftEnvelope {
  reply: string;
  /** The model's own figure; null when the envelope did not carry a usable one. */
  confidence: number | null;
  usedSourceIds: string[];
}

/** The fields an envelope may carry after the reply. */
const TAIL_KEYS = new Set(['confidence', 'used_source_ids']);
/** `{"reply": "` — the start of the envelope, with or without a code fence. */
const ENVELOPE_START = /^\s*(?:```(?:json)?\s*)?\{\s*"reply"\s*:\s*"/i;
/** The end of the reply string followed by the next field of the envelope. */
const NEXT_FIELD = /"\s*,\s*"(?:confidence|used_source_ids)"\s*:/g;

function withoutCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
}

/**
 * The model's JSON frame instead of an answer: text that opens like the
 * envelope (`{"reply": …`, with or without a code fence), or a bare JSON
 * object. No reply to a customer looks like this.
 */
export function isRawDraftEnvelope(text: string): boolean {
  const body = withoutCodeFence(text);
  if (!body.startsWith('{')) return false;
  return /^\{\s*"(?:reply|confidence|used_source_ids)"\s*:/.test(body) || body.endsWith('}');
}

/**
 * The text of a JSON string whose quoting cannot be trusted: quotes that should
 * have been escaped are taken as text, and so are real line breaks. Everything
 * JSON does escape (`\n`, `\"`, `ä` …) is decoded as usual.
 */
function decodeLooseJsonString(inner: string): string {
  let fixed = '';
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]!;
    if (char === '\\') {
      const next = inner[i + 1];
      if (next !== undefined && '"\\/bfnrtu'.includes(next)) {
        fixed += char + next;
        i += 1;
      } else {
        // a backslash JSON gives no meaning to: keep it as a character
        fixed += '\\\\';
      }
    } else if (char === '"') {
      fixed += '\\"';
    } else if (char === '\n') {
      fixed += '\\n';
    } else if (char === '\r') {
      fixed += '\\r';
    } else if (char === '\t') {
      fixed += '\\t';
    } else if (char < ' ') {
      fixed += ' ';
    } else {
      fixed += char;
    }
  }
  try {
    return JSON.parse(`"${fixed}"`) as string;
  } catch {
    // e.g. a broken \u escape: decode what a reader would expect, keep the rest
    return inner.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
}

/** `{"confidence": 0.9, "used_source_ids": […]}` — and nothing else — or null. */
function parseTail(tail: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tail);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  return Object.keys(fields).every((key) => TAIL_KEYS.has(key)) ? fields : null;
}

function envelopeOf(reply: string, fields: Record<string, unknown>): DraftEnvelope {
  return {
    reply,
    confidence:
      typeof fields.confidence === 'number' && Number.isFinite(fields.confidence)
        ? fields.confidence
        : null,
    usedSourceIds: Array.isArray(fields.used_source_ids)
      ? fields.used_source_ids.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

/**
 * Takes an envelope apart that is NOT valid JSON. The frame around the reply is
 * intact, so the reply is what stands between `{"reply": "` and the fields that
 * close the envelope. Those closing fields must parse as JSON on their own and
 * hold nothing but confidence and source ids; text inside the reply that merely
 * looks like them does not qualify. null when the text is no such envelope.
 */
export function recoverDraftEnvelope(text: string): DraftEnvelope | null {
  const start = ENVELOPE_START.exec(text);
  if (!start) return null;
  const body = text.slice(start[0].length).replace(/\s*```\s*$/, '');

  // Where the reply ends: the earliest "next field" from which the rest of the
  // envelope is clean — searched from the end, so nothing inside the reply can
  // be mistaken for it.
  let replyEnd: number | null = null;
  let tail: Record<string, unknown> = {};
  const candidates = [...body.matchAll(NEXT_FIELD)];
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const match = candidates[i]!;
    const fieldStart = match.index + match[0].indexOf('"', 1);
    const fields = parseTail(`{${body.slice(fieldStart)}`);
    if (fields) {
      replyEnd = match.index;
      tail = fields;
    } else if (replyEnd !== null) {
      break;
    }
  }
  if (replyEnd === null) {
    // an envelope that holds the reply and nothing else
    const only = /"\s*\}\s*$/.exec(body);
    if (!only) return null;
    replyEnd = only.index;
  }

  const reply = decodeLooseJsonString(body.slice(0, replyEnd));
  return reply.trim() === '' ? null : envelopeOf(reply, tail);
}

/**
 * Reads an envelope, valid JSON or not. null when the text is no envelope or
 * cannot be taken apart.
 */
export function readDraftEnvelope(text: string): DraftEnvelope | null {
  if (!isRawDraftEnvelope(text)) return null;
  try {
    const parsed: unknown = JSON.parse(withoutCodeFence(text));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const fields = parsed as Record<string, unknown>;
      if (typeof fields.reply === 'string' && fields.reply.trim() !== '') {
        return envelopeOf(fields.reply, fields);
      }
    }
  } catch {
    // not valid JSON — taken apart by its frame below
  }
  return recoverDraftEnvelope(text);
}

/**
 * What of a stored draft may be shown to an agent or sent to a customer:
 *  - ordinary text → as it is;
 *  - an envelope that can be read → its reply;
 *  - an envelope that cannot be read → null. The caller must not send it.
 */
export function draftTextForCustomer(content: string): string | null {
  if (!isRawDraftEnvelope(content)) return content;
  return readDraftEnvelope(content)?.reply ?? null;
}
