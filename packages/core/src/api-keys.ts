import { createHash, randomBytes } from 'node:crypto';

// Phase 13d — API keys of the public Zendori API. A key is 32 random bytes
// (256 bits) behind a recognisable prefix; only its SHA-256 is stored (0037).
// With that much entropy an unsalted hash is the standard, safe choice: the
// lookup stays an indexed equality match and the hash cannot be reversed.

export const API_KEY_PREFIX = 'zk_live_';
const API_KEY_PATTERN = /^zk_live_[A-Za-z0-9_-]{43}$/;
/** Characters of the key kept readable in the key list. */
const DISPLAY_PREFIX_LENGTH = 12;

export interface GeneratedApiKey {
  /** The full key — shown to the owner exactly once, never stored. */
  key: string;
  /** Leading characters, stored for recognising the key later. */
  prefix: string;
  /** Hex SHA-256 of the key, stored for the lookup. */
  hash: string;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, DISPLAY_PREFIX_LENGTH), hash: hashApiKey(key) };
}

/** Cheap shape check before any database lookup. */
export function looksLikeApiKey(value: string): boolean {
  return API_KEY_PATTERN.test(value);
}

/** The key from an `Authorization: Bearer …` header, or null. */
export function apiKeyFromAuthorization(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const key = match?.[1];
  return key && looksLikeApiKey(key) ? key : null;
}
