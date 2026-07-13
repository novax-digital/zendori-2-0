// Knowledge-base indexing (CLAUDE.md §11 Phase 4). Turns a kb_source (manual
// text, uploaded PDF/DOCX/TXT/MD, or a crawled URL / sitemap) into embedded
// kb_chunks. Text extraction runs first (read-only, may fetch the network);
// only once chunks are embedded do we replace the source's kb_chunks, so a
// transient failure leaves the existing index intact. Only metadata is logged.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { htmlToText } from '@zendori/channels';
import { chunkText, embed } from '@zendori/ai';
import type { KbSourceStatus, KbSourceType, SupabaseClient } from '@zendori/core';
import { getServiceClient } from '../db.js';

const KB_BUCKET = 'kb-files';
/** Filename of a manual-text source inside kb-files (Builder C writes it). */
const TEXT_FILENAME = 'text.txt';
/** Overall extracted-text cap before chunking (defense against huge inputs). */
const MAX_TOTAL_CHARS = 500_000;
/** Per-request fetch timeout for URL crawling. */
const FETCH_TIMEOUT_MS = 10_000;
/** Max pages fetched from a sitemap. */
const MAX_SITEMAP_PAGES = 20;
/** Max redirect hops we follow manually per crawl request (SSRF hardening). */
const MAX_REDIRECTS = 3;

interface LoadedSource {
  id: string;
  org_id: string;
  type: KbSourceType;
  uri: string | null;
  status: KbSourceStatus;
}

/**
 * Index one kb_source. Idempotent: it fully replaces the source's chunks on
 * every run. Throws on failure so pg-boss retries; the queue handler marks the
 * source `error` once retries are exhausted.
 */
export async function indexSource(sourceId: string): Promise<void> {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from('kb_sources')
    .select('id, org_id, type, uri, status')
    .eq('id', sourceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return; // source deleted before indexing ran

  const source = data as unknown as LoadedSource;
  // Idempotency guard: a duplicate/re-queued job for a source that is no longer
  // pending (already indexed, errored, or being handled) is a no-op. Pairs with
  // the 'singleton' queue policy so a redelivery never re-indexes concurrently.
  if (source.status !== 'pending') return;

  // 1. Extract text (read-only; no DB mutation yet).
  const text = (await extractSourceText(supabase, source)).slice(0, MAX_TOTAL_CHARS);
  if (text.trim().length === 0) {
    throw new Error('no text could be extracted from the source');
  }

  // 2. Chunk + embed.
  const chunks = chunkText(text);
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

async function extractSourceText(supabase: SupabaseClient, source: LoadedSource): Promise<string> {
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

async function downloadFile(supabase: SupabaseClient, path: string): Promise<{ blob: Blob }> {
  const { data, error } = await supabase.storage.from(KB_BUCKET).download(path);
  if (error || !data) throw error ?? new Error('kb file not found in storage');
  return { blob: data };
}

async function loadTextFile(
  supabase: SupabaseClient,
  orgId: string,
  sourceId: string
): Promise<string> {
  const { blob } = await downloadFile(supabase, `${orgId}/${sourceId}/${TEXT_FILENAME}`);
  return blob.text();
}

async function loadFile(supabase: SupabaseClient, source: LoadedSource): Promise<string> {
  const filename = source.uri;
  if (!filename) throw new Error('file source is missing its filename (uri)');
  const { blob } = await downloadFile(supabase, `${source.org_id}/${source.id}/${filename}`);
  const buffer = Buffer.from(await blob.arrayBuffer());
  const lower = filename.toLowerCase();

  if (lower.endsWith('.pdf')) {
    const parsed = await pdfParse(buffer);
    return parsed.text;
  }
  if (lower.endsWith('.docx')) {
    const parsed = await mammoth.extractRawText({ buffer });
    return parsed.value;
  }
  // txt / md / anything else: treat as UTF-8 text.
  return buffer.toString('utf8');
}

async function loadUrl(uri: string | null): Promise<string> {
  if (!uri) throw new Error('url source is missing its uri');
  const url = parseHttpUrl(uri);

  const first = await fetchText(url.toString());

  // Explicit <urlset> sitemap: crawl its <loc> pages.
  if (isSitemap(first)) {
    return crawlSitemap(first);
  }

  // Root URL: best-effort sitemap discovery at /sitemap.xml.
  if (url.pathname === '/' || url.pathname === '') {
    const discovered = await tryDiscoverSitemap(url, htmlToText(first));
    if (discovered !== null) return discovered;
  }

  return htmlToText(first);
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

/**
 * Only a `<urlset>` document is a crawlable sitemap. A `<sitemapindex>` is a
 * list of *other* sitemaps, not pages; treating it as a sitemap would push raw
 * XML through htmlToText (garbage), so it falls back to single-page extraction.
 */
function isSitemap(body: string): boolean {
  return /<urlset[\s>]/i.test(body);
}

/** Crawl up to MAX_SITEMAP_PAGES <loc> URLs from a sitemap into plain text. */
async function crawlSitemap(sitemapXml: string, seedText?: string): Promise<string> {
  const pageUrls = extractSitemapUrls(sitemapXml).slice(0, MAX_SITEMAP_PAGES);
  const texts: string[] = [];
  let total = 0;
  if (seedText && seedText.trim().length > 0) {
    texts.push(seedText);
    total += seedText.length;
  }
  for (const pageUrl of pageUrls) {
    if (total >= MAX_TOTAL_CHARS) break;
    try {
      const text = htmlToText(await fetchText(pageUrl));
      if (text.trim().length === 0) continue;
      texts.push(text);
      total += text.length;
    } catch {
      // Skip individual pages that fail to fetch.
    }
  }
  return texts.join('\n\n');
}

async function tryDiscoverSitemap(rootUrl: URL, seedText: string): Promise<string | null> {
  try {
    const sitemapXml = await fetchText(`${rootUrl.origin}/sitemap.xml`);
    // Only a <urlset> can be crawled into pages; a <sitemapindex> is skipped.
    if (!isSitemap(sitemapXml)) {
      return null;
    }
    const crawled = await crawlSitemap(sitemapXml, seedText);
    return crawled.trim().length > 0 ? crawled : null;
  } catch {
    return null; // discovery is best-effort
  }
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
