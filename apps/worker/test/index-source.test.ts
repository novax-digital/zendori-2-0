// Unit tests for the pure kb-source extraction helpers (no network, no DB):
// sitemap-index following, crawl boilerplate stripping, page-title extraction,
// PDF de-hyphenation and manual-text title parsing. The sitemap <loc> parser
// itself is covered in pipeline.test.ts.
import { describe, expect, it } from 'vitest';
import {
  crawledHtmlToText,
  csvQaSections,
  dehyphenatePdfText,
  extractChildSitemapUrls,
  extractPageTitle,
  extractSitemapUrls,
  isSitemapIndex,
  parseManualText,
  stripBoilerplateHtml,
} from '../src/pipeline/index-source.js';

const SITEMAP_INDEX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/post-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://example.com/page-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://example.com/category-sitemap.xml</loc></sitemap>
</sitemapindex>`;

const URLSET_XML = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
</urlset>`;

describe('isSitemapIndex', () => {
  it('detects a <sitemapindex> document', () => {
    expect(isSitemapIndex(SITEMAP_INDEX_XML)).toBe(true);
  });

  it('rejects a <urlset> sitemap and plain HTML', () => {
    expect(isSitemapIndex(URLSET_XML)).toBe(false);
    expect(isSitemapIndex('<html><body>Hallo</body></html>')).toBe(false);
  });
});

describe('extractSitemapUrls on a sitemap index', () => {
  it('returns the child sitemap URLs (generic <loc> extraction)', () => {
    expect(extractSitemapUrls(SITEMAP_INDEX_XML)).toEqual([
      'https://example.com/post-sitemap.xml',
      'https://example.com/page-sitemap.xml',
      'https://example.com/category-sitemap.xml',
    ]);
  });
});

describe('extractChildSitemapUrls', () => {
  it('sorts page sitemaps first and post sitemaps last', () => {
    expect(extractChildSitemapUrls(SITEMAP_INDEX_XML)).toEqual([
      'https://example.com/page-sitemap.xml',
      'https://example.com/category-sitemap.xml',
      'https://example.com/post-sitemap.xml',
    ]);
  });

  it('caps the number of followed child sitemaps at 5', () => {
    const entries = Array.from(
      { length: 8 },
      (_, i) => `<sitemap><loc>https://example.com/sitemap-${i}.xml</loc></sitemap>`
    ).join('');
    const xml = `<sitemapindex>${entries}</sitemapindex>`;
    expect(extractChildSitemapUrls(xml)).toHaveLength(5);
  });

  it('returns an empty list for an empty index', () => {
    expect(extractChildSitemapUrls('<sitemapindex></sitemapindex>')).toEqual([]);
  });
});

describe('stripBoilerplateHtml', () => {
  it('keeps only <main> content when present (nav/footer outside are dropped)', () => {
    const html = `<html><body>
      <nav><a href="/kontakt">Kontakt</a><a href="/impressum">Impressum</a></nav>
      <main><h1>Wallbox Pro</h1><p>Lädt mit 11 kW.</p></main>
      <footer>© Beispiel GmbH · Impressum · Datenschutz</footer>
    </body></html>`;
    const text = crawledHtmlToText(html);
    expect(text).toContain('Wallbox Pro');
    expect(text).toContain('Lädt mit 11 kW.');
    expect(text).not.toContain('Impressum');
    expect(text).not.toContain('Beispiel GmbH');
  });

  it('keeps a <header> inside <main>/<article> (it usually wraps the real H1)', () => {
    const html = `<body><article>
      <header><h1>Rücksendung</h1></header>
      <p>Rücksendungen sind innerhalb von 14 Tagen möglich.</p>
    </article><footer>Footer-Menü</footer></body>`;
    const text = crawledHtmlToText(html);
    expect(text).toContain('Rücksendung');
    expect(text).toContain('14 Tagen');
    expect(text).not.toContain('Footer-Menü');
  });

  it('strips nav/header/footer/aside/form/noscript/svg without a <main>', () => {
    const html = `<body>
      <header>Logo Menü Suche</header>
      <nav>Start Produkte Kontakt</nav>
      <p>Die Lieferzeit beträgt drei Werktage.</p>
      <aside>Verwandte Artikel</aside>
      <form><input name="q"><button>Suchen</button></form>
      <noscript>Bitte JavaScript aktivieren</noscript>
      <svg><title>Icon</title></svg>
      <footer>AGB Datenschutz Impressum</footer>
    </body>`;
    const text = crawledHtmlToText(html);
    expect(text).toContain('Lieferzeit beträgt drei Werktage');
    expect(text).not.toContain('Logo Menü Suche');
    expect(text).not.toContain('Start Produkte Kontakt');
    expect(text).not.toContain('Verwandte Artikel');
    expect(text).not.toContain('Suchen');
    expect(text).not.toContain('JavaScript aktivieren');
    expect(text).not.toContain('Icon');
    expect(text).not.toContain('AGB Datenschutz Impressum');
  });

  it('removes obvious cookie-banner containers by id/class', () => {
    const html = `<body>
      <div class="cookie-banner">Wir verwenden Cookies. <button>Akzeptieren</button></div>
      <div id="cookie-consent">Cookie-Einstellungen verwalten</div>
      <p>Unsere Wallbox lädt mit 11 kW.</p>
    </body>`;
    const text = crawledHtmlToText(html);
    expect(text).toContain('Wallbox lädt mit 11 kW');
    expect(text).not.toContain('Wir verwenden Cookies');
    expect(text).not.toContain('Cookie-Einstellungen');
  });

  it('fails safe on nested same-name tags — real content is never lost', () => {
    // The inner </nav> ends the non-greedy match early; residual boilerplate
    // text may survive, but the article content must always remain.
    const html = `<body>
      <nav><nav>Untermenü</nav>Hauptmenü</nav>
      <p>Der Versand kostet 4,90 Euro.</p>
    </body>`;
    expect(crawledHtmlToText(html)).toContain('Versand kostet 4,90 Euro');
  });

  it('keeps <main> extraction bounded by the LAST closing tag', () => {
    const html = `<main><section>Teil eins.</section></main>
      <p>Zwischenraum</p>
      <main><p>Teil zwei.</p></main>`;
    const stripped = stripBoilerplateHtml(html);
    expect(stripped).toContain('Teil eins.');
    expect(stripped).toContain('Teil zwei.');
  });
});

describe('crawledHtmlToText fallback', () => {
  it('falls back to unstripped conversion when cleaning leaves nothing', () => {
    // Page whose entire content sits inside <nav>: stripping would produce an
    // empty text and turn a working single-page source into an error.
    const html = '<body><nav>Öffnungszeiten: Mo–Fr 9–17 Uhr</nav></body>';
    expect(crawledHtmlToText(html)).toContain('Öffnungszeiten');
  });

  it('returns an empty string for empty input', () => {
    expect(crawledHtmlToText('')).toBe('');
  });
});

describe('extractPageTitle', () => {
  it('extracts and decodes the <title>', () => {
    const html = '<html><head><title>Versand &amp; Lieferung – Beispiel</title></head></html>';
    expect(extractPageTitle(html)).toBe('Versand & Lieferung – Beispiel');
  });

  it('collapses whitespace in multi-line titles', () => {
    const html = '<title>\n  Wallbox   Pro\n  kaufen\n</title>';
    expect(extractPageTitle(html)).toBe('Wallbox Pro kaufen');
  });

  it('returns null for a missing or empty title', () => {
    expect(extractPageTitle('<html><body>ohne Titel</body></html>')).toBeNull();
    expect(extractPageTitle('<title>   </title>')).toBeNull();
  });

  it('caps overlong titles at 150 characters', () => {
    const title = extractPageTitle(`<title>${'x'.repeat(400)}</title>`);
    expect(title).toHaveLength(150);
  });
});

describe('dehyphenatePdfText', () => {
  it('joins lowercase hyphenated line breaks into the compound word', () => {
    expect(dehyphenatePdfText('Die Liefer-\nzeit beträgt drei Tage.')).toBe(
      'Die Lieferzeit beträgt drei Tage.'
    );
    expect(dehyphenatePdfText('Rück-\nsendung')).toBe('Rücksendung');
  });

  it('tolerates CRLF and spaces around the line break', () => {
    expect(dehyphenatePdfText('Liefer- \r\n zeit')).toBe('Lieferzeit');
  });

  it('strips discretionary soft hyphens (U+00AD)', () => {
    expect(dehyphenatePdfText('Liefer­zeit')).toBe('Lieferzeit');
  });

  it('keeps the real hyphen when the continuation is capitalized', () => {
    expect(dehyphenatePdfText('E-Mail-\nAdresse')).toBe('E-Mail-Adresse');
    expect(dehyphenatePdfText('Baden-\nWürttemberg')).toBe('Baden-Württemberg');
  });

  it('leaves inline hyphens, number ranges and list dashes untouched', () => {
    expect(dehyphenatePdfText('Bitte per E-Mail melden.')).toBe('Bitte per E-Mail melden.');
    expect(dehyphenatePdfText('2019-\n2020')).toBe('2019-\n2020');
    expect(dehyphenatePdfText('Punkt eins -\n- Punkt zwei')).toBe('Punkt eins -\n- Punkt zwei');
  });
});

describe('parseManualText', () => {
  it('splits the stored "{title}\\n\\n{body}" format into title and body', () => {
    const section = parseManualText('Versandkosten & Lieferzeiten\n\nDer Versand kostet 4,90 €.');
    expect(section.title).toBe('Versandkosten & Lieferzeiten');
    expect(section.url).toBeNull();
    expect(section.text).toBe('Der Versand kostet 4,90 €.');
  });

  it('handles CRLF line endings', () => {
    const section = parseManualText('Titel\r\n\r\nInhalt der Notiz.');
    expect(section.title).toBe('Titel');
    expect(section.text).toBe('Inhalt der Notiz.');
  });

  it('falls back to a title-less section without a blank-line separator', () => {
    const section = parseManualText('Nur ein Fließtext ohne Titelzeile.');
    expect(section.title).toBeNull();
    expect(section.text).toBe('Nur ein Fließtext ohne Titelzeile.');
  });

  it('rejects multi-line or overlong "titles" (noisy heuristic)', () => {
    const multiline = parseManualText('Zeile eins\nZeile zwei\n\nBody');
    expect(multiline.title).toBeNull();
    const overlong = parseManualText(`${'T'.repeat(200)}\n\nBody`);
    expect(overlong.title).toBeNull();
  });

  it('keeps the full text when the body after the separator is empty', () => {
    const section = parseManualText('Nur Titel\n\n   ');
    expect(section.title).toBeNull();
    expect(section.text).toContain('Nur Titel');
  });
});

describe('csvQaSections', () => {
  it('turns each Q&A pair into its own section titled after the file', () => {
    const sections = csvQaSections('faq.csv', 'Frage;Antwort\nWie lange dauert der Versand?;3 Tage\nGibt es Garantie?;2 Jahre');
    expect(sections).toEqual([
      { title: 'faq', url: null, text: 'Frage: Wie lange dauert der Versand?\nAntwort: 3 Tage' },
      { title: 'faq', url: null, text: 'Frage: Gibt es Garantie?\nAntwort: 2 Jahre' },
    ]);
  });

  it('throws on a CSV without any valid pair (source must land on error, not empty-index)', () => {
    expect(() => csvQaSections('leer.csv', 'Frage;Antwort')).toThrow();
    expect(() => csvQaSections('kaputt.csv', 'kein;;;csv\n;;')).toThrow();
  });
});
