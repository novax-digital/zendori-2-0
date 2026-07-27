// Shared media facts. Three places need to agree on them and used to each carry
// their own copy: the upload validation in apps/web, the type dispatch in the
// worker's indexer, and the outbound attachment path in packages/channels.
//
// Deliberately dependency-free: everything here is derived from the filename, so
// no image library is needed anywhere in the monorepo. Anthropic downscales
// oversized images server-side, and the per-channel size caps below are small
// enough that we never need to re-encode a file ourselves.

/** Text-bearing documents the indexer can extract directly. */
export const KB_DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'csv'] as const;

/**
 * Image formats the indexer can describe. Exactly the four Anthropic vision
 * accepts — adding a fifth here without vision support would index binary noise.
 * Animations are not supported by the API; only the first frame is read.
 */
export const KB_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'] as const;

/** Everything a customer may upload as a knowledge source. */
export const KB_UPLOAD_EXTENSIONS = [
  ...KB_DOCUMENT_EXTENSIONS,
  ...KB_IMAGE_EXTENSIONS,
] as const;

export type KbUploadExtension = (typeof KB_UPLOAD_EXTENSIONS)[number];

/** The media_type values an Anthropic image block accepts. */
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const IMAGE_MEDIA_TYPES: Record<string, ImageMediaType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

const DOCUMENT_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

/** Lowercased extension without the dot; empty string when there is none. */
export function fileExtension(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** True for the image extensions the knowledge base can describe. */
export function isKbImageFilename(filename: string): boolean {
  return imageMediaTypeForFilename(filename) !== null;
}

/** The Anthropic image media_type for a filename, or null if it is not an image. */
export function imageMediaTypeForFilename(filename: string): ImageMediaType | null {
  return IMAGE_MEDIA_TYPES[fileExtension(filename)] ?? null;
}

/**
 * MIME type for a knowledge-base filename. Used when attaching a released file
 * to an outbound reply, where the recipient's client picks its viewer from this
 * value. Unknown extensions fall back to a type that always downloads rather
 * than renders.
 */
export function mimeForFilename(filename: string): string {
  const ext = fileExtension(filename);
  return IMAGE_MEDIA_TYPES[ext] ?? DOCUMENT_MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Verify a file really is one of the raster image formats we support, by reading
 * its magic bytes. Returns the true media type, or null for anything else.
 *
 * The filename is attacker-controlled and so is the content-type a browser sends
 * with a signed upload, so `evil.png` may hold HTML or SVG. That matters because
 * an inline-rendered signed URL executes on the storage domain — the reason
 * attachment URLs are otherwise signed with `download: true`. Sniffing is the
 * control that makes an inline image preview safe: HTML and SVG are text and can
 * never produce these signatures.
 *
 * Called wherever the bytes are already in hand (before describing an image, and
 * before attaching one to a reply), so it costs nothing extra and needs no
 * column to cache it.
 */
export function sniffImageMime(bytes: Uint8Array): ImageMediaType | null {
  const at = (i: number): number => bytes[i] ?? -1;
  // PNG: 89 'P' 'N' 'G' CR LF 1A LF
  if (
    at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 &&
    at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF (SOI + first marker)
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  // GIF: 'GIF87a' or 'GIF89a'
  if (
    at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38 &&
    (at(4) === 0x37 || at(4) === 0x39) && at(5) === 0x61
  ) {
    return 'image/gif';
  }
  // WebP: 'RIFF' <4 byte size> 'WEBP'
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Media types an attachment may be rendered INLINE for (inbox preview, chat
 * widget). Every entry is a raster format that cannot carry script, and
 * membership must always be decided together with `sniffImageMime` — never from
 * a stored or reported mime string alone, and never via `startsWith('image/')`,
 * which would admit image/svg+xml.
 */
export const INLINE_RENDERABLE_MIMES: ReadonlySet<string> = new Set<ImageMediaType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Upload cap for text documents (unchanged from the pre-image behaviour). */
export const MAX_KB_DOCUMENT_BYTES = 15 * 1024 * 1024;

/**
 * Upload cap for images. Lower than the document cap on purpose: Anthropic's
 * per-image limit is 10 MB *base64-encoded*, and base64 inflates bytes by 4/3, so
 * 7 MB of raw image is the largest that certainly still fits (7 × 4/3 ≈ 9.3 MB).
 * It also keeps every image comfortably inside the per-channel send caps below.
 */
export const MAX_KB_IMAGE_BYTES = 7 * 1024 * 1024;

/** The applicable upload cap for a given filename. */
export function maxKbUploadBytes(filename: string): number {
  return isKbImageFilename(filename) ? MAX_KB_IMAGE_BYTES : MAX_KB_DOCUMENT_BYTES;
}

/**
 * Per-message caps for files the bot attaches to a customer reply. These bound
 * blast radius as much as protocol limits: a released 15 MB manual should not
 * silently become a 15 MB attachment on every matching enquiry.
 */
export const MAX_OUTBOUND_ATTACHMENTS = 3;
/** Resend accepts far more; this is the deliberate product limit. */
export const MAX_OUTBOUND_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_OUTBOUND_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;
