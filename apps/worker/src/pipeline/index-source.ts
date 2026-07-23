// Knowledge-base indexing (CLAUDE.md §11 Phase 4). Turns a kb_source (manual
// text, uploaded PDF/DOCX/TXT/MD, or a crawled URL / sitemap / sitemap index)
// into embedded kb_chunks. Extraction yields per-document sections (one per
// crawled page/file/text); each section is chunked separately and every chunk
// gets a "Quelle: …" provenance header. Text extraction runs first (read-only,
// may fetch the network); only once chunks are embedded do we replace the
// source's kb_chunks, so a transient failure leaves the existing index intact.
// Only metadata is logged.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { htmlToText } from '@zendori/channels';
import { chunkText, embed } from '@zendori/ai';
import { parseQaCsv } from '@zendori/core';
import type { KbSourceStatus, KbSourceType, SupabaseClient } from '@zendori/core';
import { getServiceClient } from '../db.js';

const KB_BUCKET = 'kb-files';
/** Filename of a manual-text source inside kb-files (Builder C writes it). */
const TEXT_FILENAME = 'text.txt';
/** Overall extracted-text cap before chunking (defense against huge inputs). */
const MAX_TOTAL_CHARS = 500_000;
/** Per-request fetch timeout for URL crawling. */
const FETCH_TIMEOUT_MS = 10_000;
/** Max pages fetched from a sitemap (global cap, also across a sitemap index). */
const MAX_SITEMAP_PAGES = 20;
/** Max child sitemaps followed from a <sitemapindex> (one level, no recursion). */
const MAX_CHILD_SITEMAPS = 5;
/** Max redirect hops we follow manually per crawl request (SSRF hardening). */
const MAX_REDIRECTS = 3;
/** Cap for extracted document titles used as chunk context headers. */
const MAX_TITLE_CHARS = 150;

interface LoadedSource {
  id: string;
  org_id: string;
  type: KbSourceType;
  uri: string | null;
  status: KbSourceStatus;
  /** 0020: system source compiled from approved learned_answers rows. */
  is_learned?: boolean;
}

/** Newest approved learned pairs compiled into the system source (cost bound). */
const MAX_LEARNED_PAIRS = 2_000;

/**
 * One extracted document (a crawled page, an uploaded file, a manual text).
 * Sections are chunked independently — no cross-page chunks or overlap — and
 * title/url become a per-chunk provenance header ("Quelle: …").
 */
export interface ExtractedSection {
  title: string | null;
  url: string | null;
  text: string;
}

/**
 * Index one kb_source. Idempotent: it fully replaces the source's chunks on
 * every run. Throws on failure so pg-boss retries; the queue handler marks the
 * source `error` once retries are exhausted.
 */
export async function indexSource(sourceId: string): Promise<void> {
  const supabase = getServiceClient();

  // is_learned is 0020: retry without it while the migration is pending (the
  // same 42703 schema-skew pattern as elsewhere; a learned source cannot exist
  // pre-0020, so the fallback's implicit false is always correct).
  let { data, error } = await supabase
    .from('kb_sources')
    .select('id, org_id, type, uri, status, is_learned')
    .eq('id', sourceId)
    .maybeSingle();
  if (error && (error as { code?: string }).code === '42703') {
    ({ data, error } = await supabase
      .from('kb_sources')
      .select('id, org_id, type, uri, status')
      .eq('id', sourceId)
      .maybeSingle());
  }
  if (error) throw error;
  if (!data) return; // source deleted before indexing ran

  const source = data as unknown as LoadedSource;
  // Idempotency guard: a duplicate/re-queued job for a source that is no longer
  // pending (already indexed, errored, or being handled) is a no-op. Pairs with
  // the 'singleton' queue policy so a redelivery never re-indexes concurrently.
  if (source.status !== 'pending') return;

  // 1. Extract per-document sections (read-only; no DB mutation yet). The
  //    global MAX_TOTAL_CHARS cap is applied as a running budget across
  //    sections (it used to be a single slice over one concatenated blob).
  const sections = await extractSourceText(supabase, source);
  let budget = MAX_TOTAL_CHARS;
  const capped: ExtractedSection[] = [];
  for (const section of sections) {
    if (budget <= 0) break;
    const text = section.text.slice(0, budget);
    if (text.trim().length === 0) continue;
    budget -= text.length;
    capped.push({ ...section, text });
  }
  if (capped.length === 0) {
    if (source.is_learned === true) {
      // A learned source with zero approved pairs is a VALID empty state (e.g.
      // all approvals were deleted): store an empty chunk set instead of
      // erroring — the atomic replace clears stale chunks.
      const { error: clearError } = await supabase.rpc('replace_kb_chunks', {
        p_source_id: source.id,
        p_org_id: source.org_id,
        p_chunks: [],
      });
      if (clearError) throw clearError;
      const cleared = await supabase
        .from('kb_sources')
        .update({ status: 'indexed', last_indexed_at: new Date().toISOString() })
        .eq('id', source.id);
      if (cleared.error) throw cleared.error;
      return;
    }
    throw new Error('no text could be extracted from the source');
  }

  // 2. Chunk each section separately (no cross-page chunks or overlap) with a
  //    per-chunk provenance header, then embed.
  const chunks = capped.flatMap((section) =>
    chunkText(section.text, { contextHeader: sectionHeader(section) })
  );
  if (chunks.length === 0) {
    throw new Error('chunking produced no chunks');
  }
  const { vectors } = await embed(chunks.map((chunk) => chunk.content));
  if (vectors.length !== chunks.length) {
    throw new Error('embedding count does not match chunk count');
  }

  // 3. Replace the source's chunks atomically (delete + insert in one tx via
  //    RPC). No transient empty-KB window for concurrent RAG queries, and a
  //    failed insert rolls back so the prior index is never destroyed.
  const newChunks = chunks.map((chunk, index) => ({
    content: chunk.content,
    embedding: vectors[index],
    token_count: chunk.tokenCount,
  }));
  const { error: replaceError } = await supabase.rpc('replace_kb_chunks', {
    p_source_id: source.id,
    p_org_id: source.org_id,
    p_chunks: newChunks,
  });
  if (replaceError) throw replaceError;

  const upd = await supabase
    .from('kb_sources')
    .update({ status: 'indexed', last_indexed_at: new Date().toISOString() })
    .eq('id', source.id);
  if (upd.error) throw upd.error;
}

/**
 * Terminal-failure handler (called by the queue handler once retries are
 * exhausted): mark the source `error`. Never throws.
 */
export async function markIndexSourceFailed(sourceId: string): Promise<void> {
  const supabase = getServiceClient();
  try {
    await supabase.from('kb_sources').update({ status: 'error' }).eq('id', sourceId);
  } catch {
    // Best-effort: never throw from the failure handler.
  }
}

// --- text extraction ----------------------------------------------------------

/** Provenance header line for every chunk of a section (undefined = no header). */
function sectionHeader(section: ExtractedSection): string | undefined {
  if (section.title && section.url) return `Quelle: ${section.title} — ${section.url}`;
  if (section.title) return `Quelle: ${section.title}`;
  if (section.url) return `Quelle: ${section.url}`;
  return undefined;
}

async function extractSourceText(
  supabase: SupabaseClient,
  source: LoadedSource
): Promise<ExtractedSection[]> {
  // Learned system source (0020): compiled directly from the approved
  // learned_answers rows — no storage file involved, so every re-index reads
  // the current DB truth (race-free vs concurrent approvals).
  if (source.is_learned === true) {
    return loadLearnedSections(supabase, source.org_id);
  }
  switch (source.type) {
    case 'text':
      return loadTextFile(supabase, source.org_id, source.id);
    case 'file':
      return loadFile(supabase, source);
    case 'url':
      return loadUrl(source.uri);
    default:
      throw new Error(`unsupported kb_source type`);
  }
}

/**
 * One section per approved learned pair (→ one chunk per pair, like the CSV
 * import). Newest pairs win when the cap bites — old learnings age out first.
 */
async function loadLearnedSections(
  supabase: SupabaseClient,
  orgId: string
): Promise<ExtractedSection[]> {
  const { data, error } = await supabase
    .from('learned_answers')
    .select('question, answer')
    .eq('org_id', orgId)
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .limit(MAX_LEARNED_PAIRS);
  if (error) throw error;
  return ((data ?? []) as { question: string | null; answer: string | null }[])
    .reverse()
    .filter((row) => (row.question ?? '').trim().length > 0 && (row.answer ?? '').trim().length > 0)
    .map((row) => ({
      title: 'Gelernte Antworten',
      url: null,
      text: `Frage: ${(row.question ?? '').trim()}\nAntwort: ${(row.answer ?? '').trim()}`,
    }));
}

async function downloadFile(supabase: SupabaseClient, path: string): Promise<{ blob: Blob }> {
  const { data, error } = await supabase.storage.from(KB_BUCKET).download(path);
  if (error || !data) throw error ?? new Error('kb file not found in storage');
  return { blob: data };
}

/**
 * Split a stored manual text ("{title}\n\n{body}", written by addTextSource)
 * into title + body, so the human-written title reaches EVERY chunk as a
 * context header instead of only the first. Pure — unit-tested. Falls back to
 * a title-less section when the format does not match (no blank line, or a
 * "title" that is multi-line/overlong — a first-line heuristic would be noisy).
 */
export function parseManualText(raw: string): ExtractedSection {
  const normalized = raw.replace(/\r\n?/g, '\n');
  const separator = normalized.indexOf('\n\n');
  if (separator > 0) {
    const title = normalized.slice(0, separator).trim();
    const body = normalized.slice(separator + 2).trim();
    if (
      title.length > 0 &&
      title.length <= MAX_TITLE_CHARS &&
      !title.includes('\n') &&
      body.length > 0
    ) {
      return { title, url: null, text: body };
    }
  }
  return { title: null, url: null, text: normalized };
}

async function loadTextFile(
  supabase: SupabaseClient,
  orgId: string,
  sourceId: string
): Promise<ExtractedSection[]> {
  const { blob } = await downloadFile(supabase, `${orgId}/${sourceId}/${TEXT_FILENAME}`);
  return [parseManualText(await blob.text())];
}

/**
 * Repair PDF line-break hyphenation and soft hyphens so German compound nouns
 * survive extraction intact (broken tokens neither stem in the german fts leg
 * nor embed as the real word). Pure — unit-tested.
 */
export function dehyphenatePdfText(text: string): string {
  return (
    text
      // Discretionary soft hyphens (U+00AD) are never wanted in plain text.
      .replace(/­/g, '')
      // "Liefer-\nzeit" -> "Lieferzeit": lowercase-to-lowercase across a line
      // break is a typesetter hyphenation inside a word.
      .replace(/(\p{Ll})-[ \t]*\r?\n[ \t]*(\p{Ll})/gu, '$1$2')
      // "E-Mail-\nAdresse" -> "E-Mail-Adresse": keep the real hyphen, drop only
      // the line break (chunking treats \n as a sentence boundary and would
      // otherwise sever the compound).
      .replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{Lu})/gu, '$1-$2')
  );
}

/**
 * Turn a Q&A CSV into one section PER PAIR: each pair becomes its own chunk
 * (chunkText never merges sections), which is the ideal retrieval unit — the
 * question text embeds close to real customer queries and the "Quelle: {title}"
 * header still names the file. Pure — unit-tested. Zero valid pairs throws so
 * the source lands on status 'error' instead of silently indexing nothing.
 */
export function csvQaSections(filename: string, csv: string): ExtractedSection[] {
  const { pairs } = parseQaCsv(csv);
  if (pairs.length === 0) {
    throw new Error('no question/answer pairs could be parsed from the CSV');
  }
  const title = filename.replace(/\.csv$/i, '');
  return pairs.map((pair) => ({
    title,
    url: null,
    text: `Frage: ${pair.question}\nAntwort: ${pair.answer}`,
  }));
}

async function loadFile(
  supabase: SupabaseClient,
  source: LoadedSource
): Promise<ExtractedSection[]> {
  const filename = source.uri;
  if (!filename) throw new Error('file source is missing its filename (uri)');
  const { blob } = await downloadFile(supabase, `${source.org_id}/${source.id}/${filename}`);
  const buffer = Buffer.from(await blob.arrayBuffer());
  const lower = filename.toLowerCase();

  const asSection = (text: string): ExtractedSection[] => [{ title: filename, url: null, text }];

  if (lower.endsWith('.pdf')) {
    const parsed = await pdfParse(buffer);
    return asSection(dehyphenatePdfText(parsed.text));
  }
  if (lower.endsWith('.docx')) {
    const parsed = await mammoth.extractRawText({ buffer });
    return asSection(parsed.value);
  }
  if (lower.endsWith('.csv')) {
    return csvQaSections(filename, buffer.toString('utf8'));
  }
  // txt / md / anything else: treat as UTF-8 text.
  return asSection(buffer.toString('utf8'));
}

async function loadUrl(uri: string | null): Promise<ExtractedSection[]> {
  if (!uri) throw new Error('url source is missing its uri');
  const url = parseHttpUrl(uri);

  const first = await fetchText(url.toString());

  // Explicit <urlset> sitemap: crawl its <loc> pages.
  if (isSitemap(first)) {
    return crawlSitemap(first);
  }
  // A pasted <sitemapindex> URL: follow its child sitemaps (one level) instead
  // of pushing raw XML through the HTML-to-text path.
  if (isSitemapIndex(first)) {
    return crawlSitemapIndex(first);
  }

  const seed = pageSection(url.toString(), first);

  // Root URL: best-effort sitemap discovery at /sitemap.xml.
  if (url.pathname === '/' || url.pathname === '') {
    const discovered = await tryDiscoverSitemap(url, seed);
    if (discovered !== null) return discovered;
  }

  return [seed];
}

/** Build a section for one crawled page from its raw HTML. */
function pageSection(pageUrl: string, html: string): ExtractedSection {
  return { title: extractPageTitle(html), url: pageUrl, text: crawledHtmlToText(html) };
}

/**
 * Extract a page's <title> from raw HTML (before any tag stripping), decoded
 * and whitespace-collapsed, capped at MAX_TITLE_CHARS. Pure — unit-tested.
 */
export function extractPageTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = htmlToText(match[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
    .trim();
  return title.length > 0 ? title : null;
}

/** Parse + protocol-check a URL (no DNS). Network-facing checks live in safeFetch. */
function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('source uri is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http(s) URLs are supported');
  }
  return url;
}

/** A `<urlset>` document is a crawlable sitemap (a flat list of page URLs). */
function isSitemap(body: string): boolean {
  return /<urlset[\s>]/i.test(body);
}

/**
 * A `<sitemapindex>` lists *other* sitemaps (WordPress/Yoast, Shopify serve one
 * at /sitemap.xml). It is followed one level deep via crawlSitemapIndex. Pure —
 * unit-tested.
 */
export function isSitemapIndex(body: string): boolean {
  return /<sitemapindex[\s>]/i.test(body);
}

/**
 * Child sitemap URLs of a `<sitemapindex>`, capped at MAX_CHILD_SITEMAPS.
 * "page" sitemaps sort before others and "post" sitemaps last, because Yoast's
 * page-sitemap holds the key pages while post-sitemaps are often blog noise.
 * Pure — unit-tested.
 */
export function extractChildSitemapUrls(indexXml: string): string[] {
  const priority = (url: string): number => {
    if (/page/i.test(url)) return 0;
    if (/post/i.test(url)) return 2;
    return 1;
  };
  return extractSitemapUrls(indexXml)
    .slice() // stable sort on a copy
    .sort((a, b) => priority(a) - priority(b))
    .slice(0, MAX_CHILD_SITEMAPS);
}

/** Crawl up to MAX_SITEMAP_PAGES <loc> URLs from a <urlset> sitemap. */
async function crawlSitemap(
  sitemapXml: string,
  seed?: ExtractedSection
): Promise<ExtractedSection[]> {
  const pageUrls = extractSitemapUrls(sitemapXml).slice(0, MAX_SITEMAP_PAGES);
  return crawlPages(pageUrls, seed);
}

/**
 * Follow a `<sitemapindex>` ONE level deep: fetch its child sitemaps (each hop
 * re-passes the SSRF-hardened safeFetch), collect their page <loc>s up to the
 * global MAX_SITEMAP_PAGES cap, then crawl those pages. Nested sitemap indexes
 * are skipped (no recursion).
 */
async function crawlSitemapIndex(
  indexXml: string,
  seed?: ExtractedSection
): Promise<ExtractedSection[]> {
  const pageUrls: string[] = [];
  const seen = new Set<string>();
  for (const childUrl of extractChildSitemapUrls(indexXml)) {
    if (pageUrls.length >= MAX_SITEMAP_PAGES) break;
    try {
      const childXml = await fetchText(childUrl);
      if (!isSitemap(childXml)) continue; // skips nested indexes and non-sitemaps
      for (const loc of extractSitemapUrls(childXml)) {
        if (pageUrls.length >= MAX_SITEMAP_PAGES) break;
        if (seen.has(loc)) continue;
        seen.add(loc);
        pageUrls.push(loc);
      }
    } catch {
      // Skip child sitemaps that fail to fetch.
    }
  }
  return crawlPages(pageUrls, seed);
}

/** Fetch pages into per-page sections, bounded by the total character budget. */
async function crawlPages(pageUrls: string[], seed?: ExtractedSection): Promise<ExtractedSection[]> {
  const sections: ExtractedSection[] = [];
  let total = 0;
  if (seed && seed.text.trim().length > 0) {
    sections.push(seed);
    total += seed.text.length;
  }
  for (const pageUrl of pageUrls) {
    if (total >= MAX_TOTAL_CHARS) break;
    try {
      const section = pageSection(pageUrl, await fetchText(pageUrl));
      if (section.text.trim().length === 0) continue;
      sections.push(section);
      total += section.text.length;
    } catch {
      // Skip individual pages that fail to fetch.
    }
  }
  return sections;
}

async function tryDiscoverSitemap(
  rootUrl: URL,
  seed: ExtractedSection
): Promise<ExtractedSection[] | null> {
  try {
    const sitemapXml = await fetchText(`${rootUrl.origin}/sitemap.xml`);
    let crawled: ExtractedSection[];
    if (isSitemap(sitemapXml)) {
      crawled = await crawlSitemap(sitemapXml, seed);
    } else if (isSitemapIndex(sitemapXml)) {
      crawled = await crawlSitemapIndex(sitemapXml, seed);
    } else {
      return null;
    }
    return crawled.length > 0 ? crawled : null;
  } catch {
    return null; // discovery is best-effort
  }
}

// --- crawl-only HTML cleanup --------------------------------------------------

const ALWAYS_STRIP_RE = /<(nav|aside|form|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi;
const CHROME_STRIP_RE = /<(header|footer)\b[\s\S]*?<\/\1\s*>/gi;
// Obvious static cookie-banner containers by id/class. Non-greedy matching on
// nested tags fails safe: it may leave residual banner text, never real content.
const COOKIE_BLOCK_RE =
  /<(div|section)\b[^>]*\b(?:id|class)\s*=\s*(?:"[^"]*cookie[^"]*"|'[^']*cookie[^']*')[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Inner HTML of the first <main>/<article> up to its LAST close tag, or null. */
function extractMainContent(html: string): string | null {
  const open = /<(main|article)\b[^>]*>/i.exec(html);
  if (!open) return null;
  const tag = (open[1] ?? '').toLowerCase();
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
  let lastClose: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = closeRe.exec(html)) !== null) {
    lastClose = match;
  }
  if (!lastClose || lastClose.index <= open.index) return null;
  return html.slice(open.index + open[0].length, lastClose.index);
}

/**
 * Crawl-specific boilerplate stripping BEFORE text extraction, so menus,
 * footer link lists and cookie banners do not repeat into every page's chunks
 * and pollute embeddings + the german fts keyword leg. Deliberately NOT part
 * of the shared htmlToText (which the email pipeline uses). If <main>/<article>
 * is present only its content is kept (without stripping <header> inside it —
 * article headers usually wrap the real H1); otherwise <header>/<footer> are
 * stripped as page chrome. Pure — unit-tested.
 */
export function stripBoilerplateHtml(html: string): string {
  const main = extractMainContent(html);
  let scoped = (main ?? html).replace(ALWAYS_STRIP_RE, ' ');
  if (main === null) {
    scoped = scoped.replace(CHROME_STRIP_RE, ' ');
  }
  return scoped.replace(COOKIE_BLOCK_RE, ' ');
}

/**
 * htmlToText for crawled pages, with boilerplate stripped first. Falls back to
 * the unstripped conversion when cleaning leaves nothing (e.g. a page whose
 * whole content sits in an unusual markup), so a single-page URL source can
 * never regress into "no text could be extracted". Pure — unit-tested.
 */
export function crawledHtmlToText(html: string): string {
  const cleaned = htmlToText(stripBoilerplateHtml(html));
  return cleaned.trim().length > 0 ? cleaned : htmlToText(html);
}

/** Extract de-duplicated http(s) <loc> URLs from sitemap XML. Pure — unit-tested. */
export function extractSitemapUrls(xml: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const decoded = raw.replace(/&amp;/g, '&');
    try {
      const url = new URL(decoded);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !seen.has(url.toString())) {
        seen.add(url.toString());
        urls.push(url.toString());
      }
    } catch {
      // Skip malformed URLs.
    }
  }
  return urls;
}

async function fetchText(target: string): Promise<string> {
  const response = await safeFetch(target);
  if (!response.ok) {
    throw new Error(`fetch failed with HTTP ${response.status}`);
  }
  const body = await response.text();
  return body.slice(0, MAX_TOTAL_CHARS);
}

// --- SSRF-hardened fetch ------------------------------------------------------

/**
 * The single choke point for every outbound crawl request. Before each hop it
 * runs assertPublicUrl (protocol + DNS-resolved-address check) and follows
 * redirects manually so a 3xx to an internal address is re-validated instead of
 * silently followed by the fetch runtime.
 */
async function safeFetch(target: string): Promise<Response> {
  let currentUrl = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertPublicUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'ZendoriBot/1.0 (+https://zendori.de)' },
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      if (!location) throw new Error('redirect response without a location header');
      // Resolve relative redirects against the current URL; re-checked next loop.
      currentUrl = new URL(location, url).toString();
      continue;
    }
    return response;
  }
  throw new Error('too many redirects while crawling the source');
}

/**
 * Reject a URL unless it is http(s) AND every DNS-resolved address is publicly
 * routable. Blocks SSRF into loopback / private / link-local / reserved ranges.
 */
async function assertPublicUrl(value: string): Promise<URL> {
  const url = parseHttpUrl(value);
  const addresses = await resolveAddresses(url.hostname);
  if (addresses.length === 0) {
    throw new Error('could not resolve the target host');
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error('refusing to fetch a private, loopback or reserved address');
    }
  }
  return url;
}

/** Resolve a hostname to its IP strings; an IP literal resolves to itself. */
async function resolveAddresses(hostname: string): Promise<string[]> {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIP(host) !== 0) return [host];
  const resolved = await dnsLookup(host, { all: true });
  return resolved.map((entry) => entry.address);
}

/** True if the address is not a valid IP or falls in a private/reserved range. */
function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true; // unparseable → fail closed
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inCidr4(value: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

/** IPv4 ranges that must never be crawled (RFC 1918/5735/6598, loopback, …). */
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [ipv4Base(127, 0, 0, 0), 8], // loopback
  [ipv4Base(10, 0, 0, 0), 8], // private
  [ipv4Base(172, 16, 0, 0), 12], // private
  [ipv4Base(192, 168, 0, 0), 16], // private
  [ipv4Base(169, 254, 0, 0), 16], // link-local
  [ipv4Base(0, 0, 0, 0), 8], // "this network"
  [ipv4Base(100, 64, 0, 0), 10], // CGNAT
];

function ipv4Base(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => inCidr4(value, base, bits));
}

/** Expand an IPv6 literal (incl. embedded IPv4) into a 128-bit BigInt, or null. */
function ipv6ToBigInt(input: string): bigint | null {
  let ip = input.toLowerCase();
  const percent = ip.indexOf('%');
  if (percent >= 0) ip = ip.slice(0, percent); // strip zone id

  // Convert a trailing dotted-quad (::ffff:a.b.c.d / ::a.b.c.d) into two hextets.
  const lastColon = ip.lastIndexOf(':');
  if (lastColon >= 0 && ip.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToInt(ip.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(group);
  }
  return value;
}

const FULL_128 = (1n << 128n) - 1n;

function inCidr6(value: bigint, prefix: bigint, bits: number): boolean {
  const mask = FULL_128 ^ ((1n << BigInt(128 - bits)) - 1n);
  return (value & mask) === (prefix & mask);
}

function isBlockedIpv6(ip: string): boolean {
  const value = ipv6ToBigInt(ip);
  if (value === null) return true; // fail closed

  // IPv4-mapped ::ffff:0:0/96 → validate the embedded IPv4 against v4 rules.
  if (inCidr6(value, 0xffffn << 32n, 96)) {
    return isBlockedIpv4Int(Number(value & 0xffffffffn));
  }
  if (value === 0n || value === 1n) return true; // :: unspecified, ::1 loopback
  if (inCidr6(value, 0xfc00n << 112n, 7)) return true; // fc00::/7 unique-local
  if (inCidr6(value, 0xfe80n << 112n, 10)) return true; // fe80::/10 link-local
  return false;
}

function isBlockedIpv4Int(value: number): boolean {
  const v = value >>> 0;
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => inCidr4(v, base, bits));
}
