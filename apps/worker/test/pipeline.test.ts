import { describe, expect, it } from 'vitest';
import { looksLikeForm } from '../src/pipeline/process-message.js';
import { extractSitemapUrls } from '../src/pipeline/index-source.js';

describe('looksLikeForm', () => {
  it('detects a serialized form body (≥2 key: value lines)', () => {
    const body = ['name: Kai Beispiel', 'email: kai@example.com', 'nachricht: Bitte melden'].join(
      '\n'
    );
    expect(looksLikeForm(body)).toBe(true);
  });

  it('treats prose email bodies as not form-like', () => {
    const body =
      'Guten Tag,\n\nunsere Wallbox lädt seit gestern nicht mehr. Können Sie helfen?\n\nViele Grüße';
    expect(looksLikeForm(body)).toBe(false);
  });

  it('does not match a single colon line', () => {
    expect(looksLikeForm('Betreff: Rückruf erbeten')).toBe(false);
  });

  it('does not mistake URLs for key: value lines', () => {
    const body = 'Siehe https://example.com/pfad\nund http://example.org fuer Details.';
    expect(looksLikeForm(body)).toBe(false);
  });
});

describe('extractSitemapUrls', () => {
  it('extracts http(s) <loc> urls, de-duplicated and order-preserving', () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://example.com/a</loc></url>
        <url><loc>https://example.com/b</loc></url>
        <url><loc>https://example.com/a</loc></url>
      </urlset>`;
    expect(extractSitemapUrls(xml)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('decodes &amp; entities and skips non-http(s) and malformed locs', () => {
    const xml = `<urlset>
      <url><loc>https://example.com/search?q=1&amp;p=2</loc></url>
      <url><loc>ftp://example.com/file</loc></url>
      <url><loc>not a url</loc></url>
    </urlset>`;
    expect(extractSitemapUrls(xml)).toEqual(['https://example.com/search?q=1&p=2']);
  });

  it('returns an empty array when there are no <loc> entries', () => {
    expect(extractSitemapUrls('<urlset></urlset>')).toEqual([]);
  });
});
