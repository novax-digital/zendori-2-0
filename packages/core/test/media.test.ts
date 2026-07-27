import { describe, expect, it } from 'vitest';
import {
  INLINE_RENDERABLE_MIMES,
  KB_UPLOAD_EXTENSIONS,
  MAX_KB_DOCUMENT_BYTES,
  MAX_KB_IMAGE_BYTES,
  fileExtension,
  imageMediaTypeForFilename,
  isKbImageFilename,
  maxKbUploadBytes,
  mimeForFilename,
  sniffImageMime,
} from '../src/media.js';

/** Minimal byte sequences carrying each format's signature. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF87 = Buffer.from('GIF87a....', 'latin1');
const GIF89 = Buffer.from('GIF89a....', 'latin1');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'),
]);

describe('fileExtension', () => {
  it('lowercases and strips the dot', () => {
    expect(fileExtension('Anleitung.PDF')).toBe('pdf');
  });

  it('uses only the last dot and ignores directories', () => {
    expect(fileExtension('a/b.c/geraet.foto.JPEG')).toBe('jpeg');
  });

  it('returns empty for dotfiles and names without an extension', () => {
    expect(fileExtension('README')).toBe('');
    expect(fileExtension('.env')).toBe('');
    expect(fileExtension('trailing.')).toBe('');
  });
});

describe('imageMediaTypeForFilename', () => {
  it('maps both jpeg spellings to one media type', () => {
    expect(imageMediaTypeForFilename('a.jpg')).toBe('image/jpeg');
    expect(imageMediaTypeForFilename('a.jpeg')).toBe('image/jpeg');
  });

  it('is case-insensitive', () => {
    expect(imageMediaTypeForFilename('GERAET.PNG')).toBe('image/png');
  });

  it('rejects formats Anthropic vision cannot read', () => {
    // SVG is deliberately absent: it is script-bearing markup, not a raster image.
    expect(imageMediaTypeForFilename('diagramm.svg')).toBeNull();
    expect(imageMediaTypeForFilename('scan.tiff')).toBeNull();
    expect(imageMediaTypeForFilename('anleitung.pdf')).toBeNull();
  });
});

describe('sniffImageMime', () => {
  it('recognises every supported format from its signature', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(GIF87)).toBe('image/gif');
    expect(sniffImageMime(GIF89)).toBe('image/gif');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
  });

  // The reason this function exists: the filename and the upload content-type are
  // both caller-controlled, so a ".png" may hold markup. Inline rendering of that
  // on the storage domain would be stored XSS.
  it('rejects markup masquerading as an image', () => {
    expect(sniffImageMime(Buffer.from('<html><script>alert(1)</script>', 'utf8'))).toBeNull();
    expect(sniffImageMime(Buffer.from('<svg onload="alert(1)"></svg>', 'utf8'))).toBeNull();
    expect(sniffImageMime(Buffer.from('%PDF-1.7', 'utf8'))).toBeNull();
  });

  it('rejects empty and truncated input instead of throwing', () => {
    expect(sniffImageMime(new Uint8Array())).toBeNull();
    expect(sniffImageMime(PNG.subarray(0, 4))).toBeNull();
    // RIFF container that is not WebP (e.g. a WAV file).
    expect(
      sniffImageMime(
        Buffer.concat([
          Buffer.from('RIFF', 'latin1'),
          Buffer.from([0x24, 0x00, 0x00, 0x00]),
          Buffer.from('WAVE', 'latin1'),
        ])
      )
    ).toBeNull();
  });
});

describe('INLINE_RENDERABLE_MIMES', () => {
  it('contains only raster types that cannot carry script', () => {
    expect([...INLINE_RENDERABLE_MIMES].sort()).toEqual([
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });

  it('never admits svg — the whole point of an allowlist over a prefix check', () => {
    expect(INLINE_RENDERABLE_MIMES.has('image/svg+xml')).toBe(false);
  });
});

describe('mimeForFilename', () => {
  it('maps documents and images', () => {
    expect(mimeForFilename('handbuch.pdf')).toBe('application/pdf');
    expect(mimeForFilename('foto.webp')).toBe('image/webp');
  });

  it('falls back to a type that downloads rather than renders', () => {
    expect(mimeForFilename('unbekannt.xyz')).toBe('application/octet-stream');
  });
});

describe('upload limits', () => {
  it('caps images below documents so base64 stays inside the vision limit', () => {
    expect(maxKbUploadBytes('foto.png')).toBe(MAX_KB_IMAGE_BYTES);
    expect(maxKbUploadBytes('handbuch.pdf')).toBe(MAX_KB_DOCUMENT_BYTES);
    // 4/3 base64 inflation must still fit Anthropic's 10 MB per-image limit.
    expect((MAX_KB_IMAGE_BYTES * 4) / 3).toBeLessThan(10 * 1024 * 1024);
  });

  it('accepts the documented upload formats and nothing else', () => {
    expect([...KB_UPLOAD_EXTENSIONS]).toEqual([
      'pdf',
      'docx',
      'txt',
      'md',
      'csv',
      'jpg',
      'jpeg',
      'png',
      'gif',
      'webp',
    ]);
    expect(isKbImageFilename('a.jpg')).toBe(true);
    expect(isKbImageFilename('a.csv')).toBe(false);
  });
});
