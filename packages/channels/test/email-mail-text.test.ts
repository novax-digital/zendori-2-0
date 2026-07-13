import { describe, expect, it } from 'vitest';
import {
  buildReplySubject,
  htmlToText,
  parseFromHeader,
  parseThreadRefs,
  sanitizeMessageId,
  stripReplyQuotes,
} from '../src/email/mail-text.js';

describe('htmlToText', () => {
  it('strips tags and turns block elements into newlines', () => {
    const out = htmlToText('<p>Hallo</p><p>Zeile 2<br>Zeile 3</p>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out.split('\n')).toContain('Hallo');
    expect(out).toContain('Zeile 2\nZeile 3');
  });

  it('decodes the common entities', () => {
    const out = htmlToText('5 &lt; 10 &amp;&amp; 10 &gt; 5 &quot;q&quot; &#39;a&#39;&nbsp;end');
    expect(out).toBe('5 < 10 && 10 > 5 "q" \'a\' end');
  });

  it('decodes numeric and hex entities', () => {
    expect(htmlToText('caf&#233; &#x26; tee')).toBe('café & tee');
  });

  it('drops script and style blocks entirely', () => {
    const out = htmlToText('<style>.a{color:red}</style><p>Text</p><script>alert(1)</script>');
    expect(out).toBe('Text');
    expect(out).not.toContain('alert');
    expect(out).not.toContain('color:red');
  });

  it('decodes German umlaut and typographic entities case-sensitively', () => {
    expect(htmlToText('Gr&uuml;&szlig;e &auml;&ouml;&uuml; &Auml;&Ouml;&Uuml;')).toBe(
      'Grüße äöü ÄÖÜ'
    );
    expect(htmlToText('5&nbsp;&euro; &mdash; &laquo;Zitat&raquo; &copy;2026')).toBe(
      '5 € — «Zitat» ©2026'
    );
  });

  it('renders "text (URL)" for external links whose target differs from the text', () => {
    expect(htmlToText('<p>Siehe <a href="https://example.com/x">unsere Seite</a></p>')).toBe(
      'Siehe unsere Seite (https://example.com/x)'
    );
  });

  it('keeps only the text when link URL equals the visible text or is not http(s)', () => {
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe(
      'https://example.com'
    );
    expect(htmlToText('<a href="mailto:a@b.com">Mail an uns</a>')).toBe('Mail an uns');
  });

  it('leaves double-encoded entities as literal markup', () => {
    expect(htmlToText('<p>&amp;lt;b&amp;gt;</p>')).toBe('&lt;b&gt;');
  });

  it('collapses runs of blank lines and trims', () => {
    const out = htmlToText('<div>A</div><div></div><div></div><div>B</div>');
    expect(out).toBe('A\n\nB');
  });

  it('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });
});

describe('stripReplyQuotes', () => {
  it('cuts a German Apple-Mail quoted chain', () => {
    const input = [
      'Danke für die schnelle Antwort, das hat geholfen!',
      '',
      'Am 12. März 2024 um 14:30 schrieb Max Mustermann <max@example.com>:',
      '',
      '> Hallo, hier ist die Lösung für Ihr Problem.',
      '> Viele Grüße',
    ].join('\n');
    expect(stripReplyQuotes(input)).toBe('Danke für die schnelle Antwort, das hat geholfen!');
  });

  it('cuts an Outlook quoted-header block', () => {
    const input = [
      'Hier ist meine Antwort auf Ihre Frage.',
      '',
      'Von: Support <support@firma.de>',
      'Gesendet: Montag, 12. März 2024 14:30',
      'An: Kunde <kunde@example.com>',
      'Betreff: Ihre Anfrage',
      '',
      'Ursprünglicher Text hier...',
    ].join('\n');
    expect(stripReplyQuotes(input)).toBe('Hier ist meine Antwort auf Ihre Frage.');
  });

  it('cuts at the "-- " signature delimiter', () => {
    const input = ['Beste Grüße und bis bald.', '', '-- ', 'Max Mustermann', 'Firma GmbH'].join(
      '\n'
    );
    expect(stripReplyQuotes(input)).toBe('Beste Grüße und bis bald.');
  });

  it('cuts at a Gmail "On … wrote:" attribution', () => {
    const input = [
      'Passt, danke!',
      '',
      'On Mon, Mar 12, 2024 at 2:30 PM Max <max@example.com> wrote:',
      '> previous message',
    ].join('\n');
    expect(stripReplyQuotes(input)).toBe('Passt, danke!');
  });

  it('cuts at an original-message marker', () => {
    const input = ['Kurze Rückmeldung.', '-----Original Message-----', 'alter Inhalt'].join('\n');
    expect(stripReplyQuotes(input)).toBe('Kurze Rückmeldung.');
  });

  it('leaves a short message without quotes unchanged', () => {
    const input = 'Können Sie mir bitte helfen? Danke!';
    expect(stripReplyQuotes(input)).toBe(input);
  });

  it('falls back to the original when the result would be empty (full quote)', () => {
    const input = ['> Hallo,', '> hier ist die ursprüngliche Nachricht.', '> Viele Grüße'].join(
      '\n'
    );
    expect(stripReplyQuotes(input)).toBe(input);
  });

  it('does not treat prose containing "original message" as a boundary', () => {
    const input = 'The original message was never lost, it is right here.';
    expect(stripReplyQuotes(input)).toBe(input);
  });
});

describe('parseThreadRefs', () => {
  it('collects all ids from In-Reply-To and References, de-duplicated', () => {
    const ids = parseThreadRefs('<c@host>', '<a@host> <b@host> <c@host>');
    expect(ids).toEqual(['<a@host>', '<b@host>', '<c@host>']);
  });

  it('handles a single In-Reply-To with no References', () => {
    expect(parseThreadRefs('<only@host>', undefined)).toEqual(['<only@host>']);
  });

  it('returns an empty array when nothing is present', () => {
    expect(parseThreadRefs(undefined, null)).toEqual([]);
    expect(parseThreadRefs('no brackets here', '')).toEqual([]);
  });
});

describe('parseFromHeader', () => {
  it('parses a quoted display name with address', () => {
    expect(parseFromHeader('"Max Mustermann" <Max@Example.COM>')).toEqual({
      name: 'Max Mustermann',
      email: 'max@example.com',
    });
  });

  it('parses an unquoted display name', () => {
    expect(parseFromHeader('Acme Support <a@b.com>')).toEqual({
      name: 'Acme Support',
      email: 'a@b.com',
    });
  });

  it('parses angle-only and bare addresses', () => {
    expect(parseFromHeader('<a@b.com>')).toEqual({ email: 'a@b.com' });
    expect(parseFromHeader('Bare@Address.de')).toEqual({ email: 'bare@address.de' });
  });
});

describe('buildReplySubject', () => {
  it('adds a Re: prefix', () => {
    expect(buildReplySubject('Rechnung Frage')).toBe('Re: Rechnung Frage');
  });

  it('does not double an existing Re: prefix (any case)', () => {
    expect(buildReplySubject('Re: Rechnung Frage')).toBe('Re: Rechnung Frage');
    expect(buildReplySubject('RE: Rechnung')).toBe('RE: Rechnung');
  });

  it('recognizes German and forward prefixes (no "Re: Aw: …" stacking)', () => {
    expect(buildReplySubject('Aw: Rechnung')).toBe('Aw: Rechnung');
    expect(buildReplySubject('WG: Rechnung')).toBe('WG: Rechnung');
    expect(buildReplySubject('Fwd: Rechnung')).toBe('Fwd: Rechnung');
    expect(buildReplySubject('Fw: Rechnung')).toBe('Fw: Rechnung');
  });

  it('handles a null or empty subject', () => {
    expect(buildReplySubject(null)).toBe('Re:');
    expect(buildReplySubject('   ')).toBe('Re:');
  });
});

describe('sanitizeMessageId', () => {
  it('returns a single valid <token> id unchanged', () => {
    expect(sanitizeMessageId('<abc.123@host.example>')).toBe('<abc.123@host.example>');
  });

  it('extracts the id from a folded / multi-line header value', () => {
    expect(sanitizeMessageId('\r\n  <abc@host>\r\n')).toBe('<abc@host>');
  });

  it('strips injected content after a valid id (header injection defense)', () => {
    expect(sanitizeMessageId('<abc@host>\r\nBcc: attacker@evil.com')).toBe('<abc@host>');
    expect(sanitizeMessageId('<abc@host> extra text')).toBe('<abc@host>');
  });

  it('returns undefined for missing or bracket-less values', () => {
    expect(sanitizeMessageId(undefined)).toBeUndefined();
    expect(sanitizeMessageId('')).toBeUndefined();
    expect(sanitizeMessageId('no-brackets-here@host')).toBeUndefined();
    expect(sanitizeMessageId('Bcc: attacker@evil.com')).toBeUndefined();
  });
});
