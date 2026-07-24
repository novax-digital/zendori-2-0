import 'server-only';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// MD generator (Werkzeuge, owner 2026-07-24): crawls a website (single page,
// same-origin subpages or a sitemap) and converts it into ONE clean Markdown
// document — ideal RAG food for the knowledge base, downloadable as .md.
//
// The SSRF guard mirrors the battle-tested worker crawler
// (apps/worker/src/pipeline/index-source.ts): http(s) only, every DNS-resolved
// address must be publicly routable, redirects are followed manually and
// re-validated per hop. Keep both in sync when touching blocked ranges.

const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const MAX_PAGES = 12;
const PARALLEL = 3;
const WALL_BUDGET_MS = 45_000;
const MAX_HTML_CHARS = 400_000;
const MAX_TOTAL_MD_CHARS = 300_000;

// --- SSRF-hardened fetch ------------------------------------------------------

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Ungültige URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Nur http/https-Adressen sind erlaubt.');
  }
  return url;
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIP(host) !== 0) return [host];
  const resolved = await dnsLookup(host, { all: true });
  return resolved.map((entry) => entry.address);
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

const b = (a: number, c: number, d: number, e: number) =>
  ((a * 256 + c) * 256 + d) * 256 + e;

/** IPv4 ranges that must never be fetched (RFC 1918/5735/6598, loopback, …). */
const BLOCKED_IPV4: ReadonlyArray<readonly [number, number]> = [
  [b(0, 0, 0, 0), 8],
  [b(127, 0, 0, 0), 8],
  [b(10, 0, 0, 0), 8],
  [b(172, 16, 0, 0), 12],
  [b(192, 168, 0, 0), 16],
  [b(169, 254, 0, 0), 16],
  [b(100, 64, 0, 0), 10],
  [b(192, 0, 0, 0), 24],
  [b(198, 18, 0, 0), 15],
  [b(224, 0, 0, 0), 3],
];

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  return BLOCKED_IPV4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice(7);
    return isIP(mapped) === 4 ? isBlockedIpv4(mapped) : true;
  }
  // fc00::/7 (ULA), fe80::/10 (link-local)
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true; // unparseable → fail closed
}

async function assertPublicUrl(value: string): Promise<URL> {
  const url = parseHttpUrl(value);
  const addresses = await resolveAddresses(url.hostname);
  if (addresses.length === 0) throw new Error('Host konnte nicht aufgelöst werden.');
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error('Interne/private Adressen sind nicht erlaubt.');
    }
  }
  return url;
}

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
        headers: { 'user-agent': 'ZendoriBot/1.0 (+https://zendori.ai)' },
      });
    } catch (err) {
      // translate opaque network failures ("fetch failed") into actionable text
      const cause = (err as { cause?: { code?: string } }).cause;
      if (cause?.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
        throw new Error(
          'TLS-Zertifikat der Seite passt nicht zum Hostnamen (z. B. www-Variante nicht abgedeckt) — versuche die Domain ohne/mit „www".'
        );
      }
      if ((err as Error).name === 'AbortError') {
        throw new Error('Die Seite antwortet zu langsam (Timeout).');
      }
      throw new Error(`Seite nicht erreichbar${cause?.code ? ` (${cause.code})` : ''}.`);
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect ohne Ziel.');
      currentUrl = new URL(location, url).toString();
      continue;
    }
    return response;
  }
  throw new Error('Zu viele Weiterleitungen.');
}

// --- HTML → Markdown ----------------------------------------------------------

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number(code);
      return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
      const n = parseInt(code, 16);
      return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : '';
    });
}

/** Drops chrome/noise elements wholesale before conversion. */
function stripBoilerplate(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|form|template|dialog)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, '');
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return null;
  const title = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  return title.length > 0 ? title.slice(0, 150) : null;
}

/** Converts (pre-stripped) HTML into readable Markdown. */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  let s = stripBoilerplate(html);
  // body only, when present
  const body = s.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (body?.[1]) s = body[1];

  // code blocks first (protect their content from later transforms)
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, ''));
    return `\n\n\`\`\`\n${code.trim()}\n\`\`\`\n\n`;
  });

  // headings
  for (let level = 1; level <= 6; level += 1) {
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, 'gi');
    s = s.replace(re, (_, inner: string) => `\n\n${'#'.repeat(level)} ${inner}\n\n`);
  }

  // links (resolve relative hrefs), inline styles
  s = s.replace(/<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    try {
      const abs = new URL(href, baseUrl).toString();
      // link text: strip tags AND heading markers/newlines that an earlier
      // heading pass may have left inside card-style links (<a><h3>…</h3></a>)
      const text = inner
        .replace(/<[^>]+>/g, ' ')
        .replace(/#+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return text ? `[${text}](${abs})` : '';
    } catch {
      return inner;
    }
  });
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // lists + tables + quotes
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '');
  s = s.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, inner: string) => {
    const cells = [...inner.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    );
    return cells.length > 0 ? `\n| ${cells.join(' | ')} |` : '';
  });
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? `\n\n> ${text}\n\n` : '';
  });

  // block/line separators, then drop every remaining tag
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|main|ul|ol|table|figure|figcaption|dd|dt)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, ' ');

  s = decodeEntities(s);
  // tidy whitespace: per-line trim, collapse runs, max one blank line
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

// --- link & sitemap discovery -------------------------------------------------

const SKIP_EXTENSIONS =
  /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|mjs|zip|gz|rar|mp3|mp4|webm|avi|mov|woff2?|ttf|eot|xml|json|txt)([?#]|$)/i;

/** Same-origin page links from raw HTML (nav links included — they map the site). */
function extractLinks(html: string, baseUrl: string, limit: number): string[] {
  const origin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\s[^>]*href=["']([^"']+)["']/gi)) {
    const href = match[1]!;
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let abs: URL;
    try {
      abs = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (abs.origin !== origin) continue;
    if (SKIP_EXTENSIONS.test(abs.pathname)) continue;
    abs.hash = '';
    const normalized = abs.toString();
    if (normalized === baseUrl) continue;
    seen.add(normalized);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

function sitemapLocs(xml: string, sameHostAs: string, limit: number): string[] {
  const host = new URL(sameHostAs).host;
  const locs: string[] = [];
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    try {
      const url = new URL(match[1]!);
      if (url.host !== host) continue;
      locs.push(url.toString());
      if (locs.length >= limit) break;
    } catch {
      // skip malformed loc
    }
  }
  return locs;
}

// --- orchestration ------------------------------------------------------------

export interface GeneratedMarkdown {
  markdown: string;
  pageCount: number;
  skipped: string[];
  title: string;
}

interface PageResult {
  url: string;
  title: string | null;
  markdown: string;
}

async function fetchPage(url: string): Promise<PageResult | null> {
  const response = await safeFetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!/text\/html|application\/xhtml/i.test(contentType) && contentType !== '') {
    return null; // not a page
  }
  const html = (await response.text()).slice(0, MAX_HTML_CHARS);
  const markdown = htmlToMarkdown(html, url);
  if (markdown.length < 40) return null; // empty shells add noise
  return { url, title: extractTitle(html), markdown };
}

/**
 * Crawl `startUrl` (plus same-origin subpages or sitemap entries when
 * `includeSubpages`) and assemble ONE Markdown document.
 */
export async function generateSiteMarkdown(
  startUrl: string,
  includeSubpages: boolean
): Promise<GeneratedMarkdown> {
  const startedAt = Date.now();
  const start = parseHttpUrl(startUrl.trim()).toString();

  const first = await safeFetch(start);
  if (!first.ok) throw new Error(`Die Seite antwortet mit HTTP ${first.status}.`);
  const firstBody = (await first.text()).slice(0, MAX_HTML_CHARS);

  // sitemap? → its entries are the page list; otherwise page + its links
  const isSitemap = /<\s*(urlset|sitemapindex)[\s>]/i.test(firstBody);
  let pageUrls: string[];
  const pages: PageResult[] = [];
  const skipped: string[] = [];

  if (isSitemap) {
    let locs = sitemapLocs(firstBody, start, MAX_PAGES);
    if (/<\s*sitemapindex[\s>]/i.test(firstBody)) {
      // one level of child sitemaps
      const children = locs.slice(0, 3);
      locs = [];
      for (const child of children) {
        try {
          const res = await safeFetch(child);
          if (res.ok) locs.push(...sitemapLocs(await res.text(), start, MAX_PAGES - locs.length));
        } catch {
          skipped.push(child);
        }
        if (locs.length >= MAX_PAGES) break;
      }
    }
    pageUrls = locs.slice(0, MAX_PAGES);
  } else {
    const firstPage: PageResult = {
      url: start,
      title: extractTitle(firstBody),
      markdown: htmlToMarkdown(firstBody, start),
    };
    pages.push(firstPage);
    pageUrls = includeSubpages ? extractLinks(firstBody, start, MAX_PAGES - 1) : [];
  }

  // fetch remaining pages in small parallel batches within the wall budget
  for (let i = 0; i < pageUrls.length; i += PARALLEL) {
    if (Date.now() - startedAt > WALL_BUDGET_MS) {
      skipped.push(...pageUrls.slice(i));
      break;
    }
    const batch = pageUrls.slice(i, i + PARALLEL);
    const results = await Promise.allSettled(batch.map((url) => fetchPage(url)));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) pages.push(result.value);
      else if (result.status === 'rejected') skipped.push(batch[index]!);
    });
  }

  if (pages.length === 0) {
    throw new Error('Es konnte kein Inhalt extrahiert werden.');
  }

  const siteTitle = pages[0]?.title ?? new URL(start).host;
  const parts: string[] = [
    `# ${siteTitle}`,
    '',
    `> Automatisch erzeugt aus ${start} · ${pages.length} Seite${pages.length === 1 ? '' : 'n'} · ${new Date().toLocaleDateString('de-DE')}`,
  ];
  let total = parts.join('\n').length;
  for (const page of pages) {
    const section = [
      '',
      '---',
      '',
      `## ${page.title ?? page.url}`,
      '',
      `_Quelle: ${page.url}_`,
      '',
      page.markdown,
    ].join('\n');
    if (total + section.length > MAX_TOTAL_MD_CHARS) {
      skipped.push(page.url);
      continue;
    }
    parts.push(section);
    total += section.length;
  }

  return {
    markdown: parts.join('\n'),
    pageCount: pages.length,
    skipped,
    title: siteTitle,
  };
}
