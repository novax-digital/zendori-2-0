// Pure e-mail text helpers: HTML → plain text, reply-quote stripping, RFC
// header parsing. No network, no env, no side effects — fully unit-tested.
// Reply-stripping concept follows docs/legacy-analysis.md §2.8 (re-implemented,
// not copied), applied conservatively with a safety-net against empty output.

// --- HTML → text -------------------------------------------------------------

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Named entities decoded case-sensitively (German umlauts differ only by the
 * first letter's case: `&auml;` → ä vs `&Auml;` → Ä).
 */
const NAMED_ENTITIES: Record<string, string> = {
  // German umlauts / sharp s
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  // typography / currency / symbols
  euro: '€',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
};

/** Base entities decoded case-insensitively (classic HTML core set). `amp` is
 * intentionally excluded here — it is decoded last (see decodeEntities). */
const CASE_INSENSITIVE_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Resolve a named entity (case-sensitive first, then the case-insensitive base
 * set). Returns undefined for unknown names and for `amp` (handled last). */
function lookupNamedEntity(name: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)) return NAMED_ENTITIES[name];
  const lower = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CASE_INSENSITIVE_ENTITIES, lower)) {
    return CASE_INSENSITIVE_ENTITIES[lower];
  }
  return undefined;
}

/** Decode the HTML entities we expect in support mail: named (German umlauts,
 * typographic/currency symbols, base set), numeric decimal and hex. `&amp;` is
 * decoded LAST so double-encoded sequences like `&amp;lt;` decode to the literal
 * `&lt;` instead of `<`. */
function decodeEntities(input: string): string {
  return input
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) => lookupNamedEntity(name) ?? match)
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      safeFromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&amp;/gi, '&');
}

const BLOCK_TAGS =
  'p|div|h[1-6]|li|tr|table|thead|tbody|blockquote|section|article|header|footer|nav|pre|ul|ol';

/**
 * Convert an HTML body to readable plain text: drop script/style/comments,
 * turn line breaks and block elements into newlines, strip remaining tags,
 * decode entities, and collapse runs of blank lines.
 */
export function htmlToText(html: string): string {
  if (!html) return '';
  let text = html;
  text = text.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Preserve link targets: "<a href="URL">text</a>" → "text (URL)" when the URL
  // is http(s) and differs from the visible text; otherwise keep just the text.
  text = text.replace(
    /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, _raw, dq: string, sq: string, uq: string, inner: string) => {
      const url = (dq ?? sq ?? uq ?? '').trim();
      const visible = inner.replace(/<[^>]+>/g, '').trim();
      if (/^https?:\/\//i.test(url) && url !== visible) {
        return visible ? `${visible} (${url})` : url;
      }
      return inner;
    }
  );
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Table/heading cells separate content that would otherwise concatenate.
  text = text.replace(/<\/?(?:td|th)\b[^>]*>/gi, ' ');
  text = text.replace(new RegExp(`<(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  text = text.replace(new RegExp(`</(?:${BLOCK_TAGS})>`, 'gi'), '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  text = text.replace(/\r\n?/g, '\n');
  // Collapse horizontal whitespace (spaces, tabs, NBSP, …) per line, keep newlines.
  text = text
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trimEnd())
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

// --- reply-quote stripping ---------------------------------------------------

const ORIGINAL_MESSAGE_MARKER =
  /^[-_\s]*(?:original message|original-nachricht|ursprüngliche nachricht|weitergeleitete nachricht|forwarded message)[-_\s:]*$/i;
const BEGIN_FORWARDED = /^begin forwarded message:?$/i;
const APPLE_MAIL_DE = /^Am\s.+\sschrieb\b.*:$/i; // "Am … schrieb …:"
const GMAIL_ATTRIBUTION = /^On\s.+\swrote:$/i; // "On … wrote:"
const HEADER_START = /^(?:from|von):\s?\S/i; // Outlook quoted-header block start
const HEADER_FOLLOW = /^(?:sent|gesendet|to|an|cc|subject|betreff|date|datum):/i;
const UNDERSCORE_RULE = /^_{5,}$/; // Outlook underscore separator

function isReplyBoundary(lines: string[], index: number): boolean {
  const trimmed = lines[index]?.trim() ?? '';
  if (trimmed === '') return false;

  // RFC 3676 signature delimiter ("-- ", trailing space stripped by trim()).
  if (trimmed === '--') return true;
  if (UNDERSCORE_RULE.test(trimmed)) return true;
  if (ORIGINAL_MESSAGE_MARKER.test(trimmed) || BEGIN_FORWARDED.test(trimmed)) return true;

  // Attribution lines can soft-wrap; also test a joined 2-line window.
  const next = lines[index + 1]?.trim() ?? '';
  const windowed = next ? `${trimmed} ${next}` : trimmed;
  if (APPLE_MAIL_DE.test(trimmed) || APPLE_MAIL_DE.test(windowed)) return true;
  if (GMAIL_ATTRIBUTION.test(trimmed) || GMAIL_ATTRIBUTION.test(windowed)) return true;

  // Outlook: "Von:/From:" only counts as a boundary when a header block follows.
  if (HEADER_START.test(trimmed)) {
    for (let j = index + 1; j <= index + 4 && j < lines.length; j++) {
      if (HEADER_FOLLOW.test(lines[j]?.trim() ?? '')) return true;
    }
  }
  return false;
}

/**
 * Remove quoted history from a reply, conservatively: cut at the earliest
 * recognized boundary (signature, forward/original marker, attribution line,
 * or Outlook header block), then drop leading `>`-quoted lines. If that leaves
 * nothing (e.g. a full-quote reply), return the original text unchanged.
 */
export function stripReplyQuotes(text: string): string {
  if (!text) return text;
  const original = text;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  let cutIndex = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (isReplyBoundary(lines, i)) {
      cutIndex = i;
      break;
    }
  }

  const kept = lines.slice(0, cutIndex).filter((line) => !/^\s*>/.test(line));
  const result = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return result.length > 0 ? result : original.trim();
}

// --- header parsing ----------------------------------------------------------

/**
 * Collect every RFC message-id (`<…>`) from In-Reply-To and References headers,
 * de-duplicated, References first (chronological chain) then In-Reply-To.
 */
export function parseThreadRefs(inReplyTo?: string | null, references?: string | null): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const collect = (value?: string | null): void => {
    if (!value) return;
    const matches = value.match(/<[^<>\s]+>/g);
    if (!matches) return;
    for (const id of matches) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  };
  collect(references);
  collect(inReplyTo);
  return ids;
}

/**
 * Parse a From header into name + email. Handles `"Name" <a@b>`, `Name <a@b>`,
 * `<a@b>` and a bare `a@b`. The email is lowercased.
 */
export function parseFromHeader(from: string): { name?: string; email: string } {
  const raw = (from ?? '').trim();
  const angle = raw.match(/^(.*)<\s*([^<>]+?)\s*>\s*$/);
  if (angle) {
    const email = (angle[2] ?? '').trim().toLowerCase();
    const name = (angle[1] ?? '')
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1')
      .trim();
    return name ? { name, email } : { email };
  }
  return { email: raw.toLowerCase() };
}

/** Reply/forward prefixes we treat as "already a reply subject" (EN + DE):
 * Re:, Aw: (Antwort), Wg: (Weitergeleitet), Fw:/Fwd:. */
const REPLY_PREFIX = /^(re|aw|wg|fwd?):\s*/i;

/** Build a reply subject with a single reply prefix — never doubles it and does
 * not stack "Re:" on top of an existing "Aw:"/"WG:"/"Fwd:" prefix. */
export function buildReplySubject(subject: string | null): string {
  const base = (subject ?? '').trim();
  if (!base) return 'Re:';
  if (REPLY_PREFIX.test(base)) return base;
  return `Re: ${base}`;
}

/**
 * Reduce a raw Message-ID header value to a single, strictly valid `<token>` id.
 * Uses the same extraction as parseThreadRefs so injected content (extra
 * addresses, folded/multi-line headers, CR/LF) cannot leak into outbound
 * headers. Returns undefined when no valid id can be extracted.
 */
export function sanitizeMessageId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const candidate = raw.match(/<[^<>\s]+>/g)?.[0];
  if (candidate && /^<[^<>\s]+>$/.test(candidate)) return candidate;
  return undefined;
}
